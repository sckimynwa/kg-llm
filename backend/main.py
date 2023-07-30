import os
from typing import Optional

from components.question_proposal_generator import (
    QuestionProposalGenerator,
)
from components.summarize_cypher_result import SummarizeCypherResult
from components.text2cypher import Text2Cypher

from driver.neo4j import Neo4jDatabase
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from utils.fewshot_examples import get_fewshot_examples
from llm.openai import OpenAIChat
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

class Payload(BaseModel):
    question: str
    api_key: Optional[str]
    model_name: Optional[str]


class ImportPayload(BaseModel):
    input: str
    neo4j_schema: Optional[str]
    api_key: Optional[str]

# Maximum number of records used in the context
HARD_LIMIT_CONTEXT_RECORDS = 10

neo4j_connection = Neo4jDatabase(
    host=os.environ.get("NEO4J_URL"),
    user=os.environ.get("NEO4J_USER"),
    password=os.environ.get("NEO4J_PASS"),
    database=os.environ.get("NEO4J_DATABASE"),
)

# Initialize LLM modules
openai_api_key = os.environ.get("OPENAI_API_KEY", None)

# Define FastAPI endpoint
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/questionProposalsForCurrentDb")
async def questionProposalsForCurrentDb():
    api_key = openai_api_key;

    questionProposalGenerator = QuestionProposalGenerator(
        database=neo4j_connection,
        llm=OpenAIChat(
            openai_api_key=api_key,
            model_name="gpt-3.5-turbo-0613",
            max_tokens=512,
            temperature=0.8,
        ),
    )

    return questionProposalGenerator.run()



@app.websocket("/text2text")
async def websocket_endpoint(websocket: WebSocket):
    async def sendDebugMessage(message):
        await websocket.send_json({"type": "debug", "detail": message})

    async def sendErrorMessage(message):
        await websocket.send_json({"type": "error", "detail": message})

    async def onToken(token):
        delta = token["choices"][0]["delta"]
        if "content" not in delta:
            return
        content = delta["content"]
        if token["choices"][0]["finish_reason"] == "stop":
            await websocket.send_json({"type": "end", "output": content})
        else:
            await websocket.send_json({"type": "stream", "output": content})

        # await websocket.send_json({"token": token})

    await websocket.accept()
    await sendDebugMessage("connected")
    chatHistory = []
    try:
        while True:
            data = await websocket.receive_json()
            if not openai_api_key and not data.get("api_key"):
                raise HTTPException(
                    status_code=422,
                    detail="Please set OPENAI_API_KEY environment variable or send it as api_key in the request body",
                )
            api_key = openai_api_key if openai_api_key else data.get("api_key")

            default_llm = OpenAIChat(
                openai_api_key=api_key,
                model_name=data.get("model_name", "gpt-3.5-turbo-0613"),
            )
            summarize_results = SummarizeCypherResult(
                llm=OpenAIChat(
                    openai_api_key=api_key,
                    model_name="gpt-3.5-turbo-0613",
                    max_tokens=128,
                )
            )

            text2cypher = Text2Cypher(
                database=neo4j_connection,
                llm=default_llm,
                cypher_examples=get_fewshot_examples(api_key),
            )

            if "type" not in data:
                await websocket.send_json({"error": "missing type"})
                continue
            if data["type"] == "question":
                try:
                    question = data["question"]
                    chatHistory.append({"role": "user", "content": question})
                    await sendDebugMessage("received question: " + question)
                    results = None
                    try:
                        results = text2cypher.run(question, chatHistory)
                        print("results", results)
                    except Exception as e:
                        await sendErrorMessage(str(e))
                        continue
                    if results == None:
                        await sendErrorMessage("Could not generate Cypher statement")
                        continue

                    await websocket.send_json(
                        {
                            "type": "start",
                        }
                    )
                    output = await summarize_results.run_async(
                        question,
                        results["output"][:HARD_LIMIT_CONTEXT_RECORDS],
                        callback=onToken,
                    )
                    chatHistory.append({"role": "system", "content": output})
                    await websocket.send_json(
                        {
                            "type": "end",
                            "output": output,
                            "generated_cypher": results["generated_cypher"],
                        }
                    )
                except Exception as e:
                    await sendErrorMessage(str(e))
                await sendDebugMessage("output done")
    except WebSocketDisconnect:
        print("disconnected")

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.get("/ready")
async def readiness_check():
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, port=int(os.environ.get("PORT", 7860)), host="0.0.0.0")
