import * as vscode from 'vscode';
import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';
import { collectGitChangeMarkers } from '../../editor/gitChangeMarkers';

jest.mock('../../editor/gitChangeMarkers', () => ({
  collectGitChangeMarkers: jest.fn(),
  revertGitChangeInContent: jest.fn((content: string) => content),
}));

const collectGitChangeMarkersMock = collectGitChangeMarkers as jest.MockedFunction<
  typeof collectGitChangeMarkers
>;

type MockWebview = {
  postMessage: jest.Mock<Promise<boolean>, [unknown]>;
};

function createDocument(readText: () => string) {
  return {
    getText: jest.fn(readText),
    uri: {
      scheme: 'file',
      fsPath: '/repo/story.md',
      toString: () => 'file:///repo/story.md',
    },
  };
}

function registerPanel(
  provider: MarkdownEditorProvider,
  document: ReturnType<typeof createDocument>,
  webview: MockWebview
) {
  const providerAccess = provider as unknown as {
    openPanels: Map<string, { panel: { webview: typeof webview }; document: unknown }>;
    gitChangeGenerations: Map<string, number>;
  };
  const docUri = document.uri.toString();
  providerAccess.openPanels.set(docUri, {
    panel: { webview },
    document,
  });
  providerAccess.gitChangeGenerations.set(docUri, 1);
}

async function sendMarkers(
  provider: MarkdownEditorProvider,
  document: ReturnType<typeof createDocument>,
  webview: MockWebview,
  generation = 1
) {
  await (
    provider as unknown as {
      sendGitChangeMarkers: (
        doc: vscode.TextDocument,
        webview: MockWebview,
        generation: number,
        force?: boolean
      ) => Promise<void>;
    }
  ).sendGitChangeMarkers(document as unknown as vscode.TextDocument, webview, generation);
}

describe('MarkdownEditorProvider Git change marker payloads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    collectGitChangeMarkersMock.mockResolvedValue([
      {
        type: 'modified',
        startLine: 2,
        endLine: 2,
        oldLines: ['old'],
        newLines: ['new'],
      },
    ]);
  });

  it('sends current source text with Git marker updates for webview projection', async () => {
    const text = 'intro\nnew\noutro';
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument(() => text);
    const webview: MockWebview = { postMessage: jest.fn(async (_message: unknown) => true) };
    registerPanel(provider, document, webview);

    await sendMarkers(provider, document, webview);

    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gitChangesUpdate',
        sourceContentForMarkers: text,
        sourceLineCount: 3,
      })
    );
  });

  it('re-sends marker updates when source text changes even if hunk ranges are unchanged', async () => {
    let text = 'intro\nnew\noutro';
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument(() => text);
    const webview: MockWebview = { postMessage: jest.fn(async (_message: unknown) => true) };
    registerPanel(provider, document, webview);

    await sendMarkers(provider, document, webview);

    text = 'rewritten intro\nnew\noutro';
    (
      provider as unknown as {
        gitChangeGenerations: Map<string, number>;
      }
    ).gitChangeGenerations.set(document.uri.toString(), 2);
    await sendMarkers(provider, document, webview, 2);

    expect(webview.postMessage).toHaveBeenCalledTimes(2);
    const postMessageCalls = webview.postMessage.mock.calls as Array<[unknown]>;
    expect(postMessageCalls[1][0]).toEqual(
      expect.objectContaining({
        sourceContentForMarkers: 'rewritten intro\nnew\noutro',
      })
    );
  });
});
