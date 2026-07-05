import * as vscode from 'vscode';
import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';
import { exportDocument } from '../../features/documentExport';

jest.mock('../../features/documentExport', () => ({
  exportDocument: jest.fn(),
}));

describe('MarkdownEditorProvider Mermaid export payloads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes webview Mermaid image payloads through to export backends', async () => {
    const provider = new MarkdownEditorProvider({} as vscode.ExtensionContext);
    const document = {
      uri: vscode.Uri.file('/workspace/docs/note.md'),
    } as vscode.TextDocument;
    const mermaidImage = {
      id: 'mermaid-0',
      pngDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      originalSvg: '<svg viewBox="0 0 10 10"></svg>',
    };

    await (
      provider as unknown as {
        handleExportDocument: (
          message: { type: string; [key: string]: unknown },
          document: vscode.TextDocument
        ) => Promise<void>;
      }
    ).handleExportDocument(
      {
        type: 'exportDocument',
        format: 'pdf',
        html: '<div class="mermaid-wrapper" data-mermaid-id="mermaid-0"></div>',
        mermaidImages: [
          mermaidImage,
          {
            id: 'bad-image',
            pngDataUrl: 42,
            originalSvg: '<svg></svg>',
          },
        ],
        title: 'Diagram Doc',
      },
      document
    );

    expect(exportDocument).toHaveBeenCalledWith(
      'pdf',
      '<div class="mermaid-wrapper" data-mermaid-id="mermaid-0"></div>',
      [mermaidImage],
      'Diagram Doc',
      document
    );
  });
});
