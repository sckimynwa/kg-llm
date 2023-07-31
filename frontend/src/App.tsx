import { useEffect, useState } from "react";
import useWebSocket, { ReadyState } from "react-use-websocket";
import ChatContainer from "./components/ChatContainer";
import ChatInput from "./components/ChatInput";
import type { ChatMessageObject } from "./components/ChatMessage";
import type {
  ConversationState,
  WebSocketRequest,
  WebSocketResponse,
} from "./components/types/websocketTypes";

const TEXT_TO_CYPHER_MODEL = "gpt-3.5-turbo-0613";
const URI = "ws://localhost:7860/text2text";
const QUESTIONS_URI = "http://localhost:7860/questionProposalsForCurrentDb";

function stripQuestionPrefix(question: string): string {
  const QUESTION_PREFIX_REGEXP = /^[0-9]{1,2}[\w]*[.)-]*[\w]*/;

  if (question.match(QUESTION_PREFIX_REGEXP)) {
    return question.replace(QUESTION_PREFIX_REGEXP, "");
  }
  return question;
}

function App() {
  const [chatMessages, setChatMessages] = useState<ChatMessageObject[]>([]);
  const [conversationState, setConversationState] =
    useState<ConversationState>("ready");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sampleQuestions, setSampleQuestions] = useState<string[]>([]);

  const { sendJsonMessage, lastMessage, readyState } = useWebSocket(URI, {
    shouldReconnect: () => true,
    reconnectInterval: 5000,
  });

  useEffect(() => {
    async function loadSampleQuestions() {
      const options = {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      };
      try {
        const response = await fetch(QUESTIONS_URI, options);
        const result = await response.json();
        setSampleQuestions(result.output?.map(stripQuestionPrefix) ?? []);
      } catch (err) {
        setSampleQuestions([]);
      }
    }

    loadSampleQuestions();
  }, []);

  useEffect(() => {
    if (!lastMessage) return;

    const websocketResponse = JSON.parse(lastMessage.data) as WebSocketResponse;

    if (websocketResponse.type === "debug") {
      console.log(websocketResponse.detail);
    } else if (websocketResponse.type === "error") {
      setConversationState("error");
      setErrorMessage(websocketResponse.detail);
      console.error(websocketResponse.detail);
    } else if (websocketResponse.type === "start") {
      setConversationState("streaming");

      setChatMessages((chatMessages) => [
        ...chatMessages,
        {
          id: chatMessages.length,
          type: "text",
          sender: "bot",
          message: "",
          complete: false,
        },
      ]);
    } else if (websocketResponse.type === "stream") {
      setChatMessages((chatMessages) => {
        const lastChatMessage = chatMessages[chatMessages.length - 1];
        const rest = chatMessages.slice(0, -1);

        return [
          ...rest,
          {
            ...lastChatMessage,
            message: lastChatMessage.message + websocketResponse.output,
          },
        ];
      });
    } else if (websocketResponse.type === "end") {
      setChatMessages((chatMessages) => {
        const lastChatMessage = chatMessages[chatMessages.length - 1];
        const rest = chatMessages.slice(0, -1);
        return [
          ...rest,
          {
            ...lastChatMessage,
            complete: true,
            cypher: websocketResponse.generated_cypher,
          },
        ];
      });
      setConversationState("ready");
    }
  }, [lastMessage]);

  useEffect(() => {
    if (conversationState === "error") {
      const timeout = setTimeout(() => {
        setConversationState("ready");
      }, 1000);
      return () => clearTimeout(timeout);
    }
  }, [conversationState]);

  const sendQuestion = (question: string) => {
    const webSocketRequest: WebSocketRequest = {
      type: "question",
      question: question,
    };
    webSocketRequest.model_name = TEXT_TO_CYPHER_MODEL;
    sendJsonMessage(webSocketRequest);
  };

  const onChatInput = (message: string) => {
    if (conversationState === "ready") {
      setChatMessages((chatMessages) =>
        chatMessages.concat([
          {
            id: chatMessages.length,
            type: "input",
            sender: "self",
            message: message,
            complete: true,
          },
        ])
      );
      setConversationState("waiting");
      sendQuestion(message);
      setErrorMessage(null);
    }
  };

  return (
    <div className="flex flex-col min-w-[800px] min-h-[100vh] bg-palette-neutral-bg-strong">
      <div className="p-6 mx-auto mt-20 rounded-lg bg-palette-neutral-bg-weak min-h-[6rem] min-w-[18rem] max-w-4xl ">
        {readyState === ReadyState.OPEN && (
          <>
            <ChatContainer
              chatMessages={chatMessages}
              loading={conversationState === "waiting"}
            />
            <ChatInput
              onChatInput={onChatInput}
              loading={conversationState === "waiting"}
              sampleQuestions={sampleQuestions}
            />
            {errorMessage}
          </>
        )}
        {readyState === ReadyState.CONNECTING && <div>Connecting...</div>}
        {readyState === ReadyState.CLOSED && (
          <div className="flex flex-col">
            <div>Could not connect to server, reconnecting...</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
