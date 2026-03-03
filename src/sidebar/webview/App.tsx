import { useReducer, useEffect } from "preact/hooks";
import type {
  SidebarState,
  TrackedCallInfo,
  FeedbackEntry,
  IndexStatusInfo,
  ExtensionMessage,
  PostCommand,
} from "./types.js";
import { ActiveToolCalls } from "./components/ActiveToolCalls.js";
import { ServerStatus } from "./components/ServerStatus.js";
import { IndexStatus } from "./components/IndexStatus.js";
import { Configuration } from "./components/Configuration.js";
import { WriteApproval } from "./components/WriteApproval.js";
import { TrustedPaths } from "./components/TrustedPaths.js";
import { TrustedCommands } from "./components/TrustedCommands.js";
import { AvailableTools } from "./components/AvailableTools.js";
import { FeedbackList } from "./components/FeedbackList.js";
import { CollapsibleSection } from "./components/common/CollapsibleSection.js";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

interface AppProps {
  vscodeApi: VsCodeApi;
}

interface State {
  sidebar: SidebarState;
  toolCalls: TrackedCallInfo[];
  feedbackEntries: FeedbackEntry[];
}

type Action =
  | { type: "stateUpdate"; state: SidebarState }
  | { type: "updateToolCalls"; calls: TrackedCallInfo[] }
  | { type: "updateFeedback"; entries: FeedbackEntry[] }
  | { type: "updateIndexStatus"; status: IndexStatusInfo };

const initialState: State = {
  sidebar: {
    serverRunning: false,
    port: null,
    sessions: 0,
    authEnabled: true,
    agentConfigured: false,
    masterBypass: false,
  },
  toolCalls: [],
  feedbackEntries: [],
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "stateUpdate":
      return { ...state, sidebar: action.state };
    case "updateToolCalls":
      return { ...state, toolCalls: action.calls };
    case "updateFeedback":
      return { ...state, feedbackEntries: action.entries };
    case "updateIndexStatus":
      return {
        ...state,
        sidebar: { ...state.sidebar, indexStatus: action.status },
      };
    default:
      return state;
  }
}

export function App({ vscodeApi }: AppProps) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const postCommand: PostCommand = (command, data) => {
    vscodeApi.postMessage({ command, ...data });
  };

  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionMessage>) => {
      const msg = event.data;
      if (
        msg.type === "stateUpdate" ||
        msg.type === "updateToolCalls" ||
        msg.type === "updateFeedback" ||
        msg.type === "updateIndexStatus"
      ) {
        dispatch(msg);
      }
    };
    window.addEventListener("message", handler);
    // Tell extension we're ready to receive state
    vscodeApi.postMessage({ command: "webviewReady" });
    return () => window.removeEventListener("message", handler);
  }, []);

  // During onboarding, show only the agent picker/confirmation
  if (state.sidebar.onboardingStep) {
    return (
      <div>
        <Configuration state={state.sidebar} postCommand={postCommand} />
      </div>
    );
  }

  return (
    <div>
      <ActiveToolCalls calls={state.toolCalls} postCommand={postCommand} />
      <ServerStatus state={state.sidebar} postCommand={postCommand} />
      <IndexStatus state={state.sidebar} postCommand={postCommand} />
      <Configuration state={state.sidebar} postCommand={postCommand} />
      <WriteApproval state={state.sidebar} postCommand={postCommand} />
      <TrustedPaths state={state.sidebar} postCommand={postCommand} />
      <TrustedCommands state={state.sidebar} postCommand={postCommand} />
      <AvailableTools />
      {__DEV_BUILD__ && (
        <FeedbackList
          entries={state.feedbackEntries}
          postCommand={postCommand}
        />
      )}
      {__DEV_BUILD__ && (
        <CollapsibleSection title="Dev Tools">
          <div class="button-group">
            <button
              class="btn btn-secondary"
              onClick={() => postCommand("resetOnboarding")}
            >
              Reset Onboarding
            </button>
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}
