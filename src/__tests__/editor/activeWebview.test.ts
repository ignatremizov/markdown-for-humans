import * as vscode from 'vscode';
import {
  getActiveWebviewDocument,
  getActiveWebviewPanel,
  onDidChangeActiveWebview,
  setActiveWebviewPanel,
} from '../../activeWebview';
import { createMockTextDocument } from '../../__mocks__/vscode';

describe('activeWebview', () => {
  afterEach(() => {
    setActiveWebviewPanel(undefined);
  });

  it('tracks the active custom-editor panel and document', () => {
    const panel = {} as vscode.WebviewPanel;
    const document = createMockTextDocument('Hello world') as vscode.TextDocument;

    setActiveWebviewPanel(panel, document);

    expect(getActiveWebviewPanel()).toBe(panel);
    expect(getActiveWebviewDocument()).toBe(document);
  });

  it('fires when the active custom-editor document changes', () => {
    const listener = jest.fn();
    const subscription = onDidChangeActiveWebview(listener);
    const document = createMockTextDocument('Hello world') as vscode.TextDocument;

    setActiveWebviewPanel({} as vscode.WebviewPanel, document);
    setActiveWebviewPanel(undefined);
    subscription.dispose();

    expect(listener).toHaveBeenNthCalledWith(1, document);
    expect(listener).toHaveBeenNthCalledWith(2, undefined);
  });
});
