import { isValidElement, useState, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { isExternalLinkAllowed } from '@shared/url-policy';
import { CheckIcon, CopyIcon, ExternalLinkIcon } from '@renderer/components/icons';
import { copyToClipboard } from '@renderer/lib/clipboard';
import { openExternalLink } from '@renderer/lib/external';
import { toast } from '@renderer/lib/toast';
import './markdown.css';

type TextElement = ReactElement<{ className?: string; children?: ReactNode }>;

function findElement(node: ReactNode): TextElement | null {
  if (isValidElement<{ className?: string; children?: ReactNode }>(node)) return node;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child);
      if (found) return found;
    }
  }
  return null;
}

function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return extractText(node.props.children);
  return '';
}

function languageOf(node: ReactNode): string | null {
  const element = findElement(node);
  const className = element?.props.className;
  if (typeof className !== 'string') return null;
  const match = /language-([\w+#.-]+)/.exec(className);
  return match?.[1] ?? null;
}

interface CodeBlockProps {
  children?: ReactNode;
}

/**
 * Fenced code with a copy action. The language comes from the class
 * `rehype-highlight` produced; the text copied is the literal code text, not
 * the highlighted markup.
 */
function CodeBlock({ children }: CodeBlockProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const text = extractText(children);
  const language = languageOf(children);

  const copy = async (): Promise<void> => {
    const ok = await copyToClipboard(text);
    if (!ok) {
      toast.danger('Nothing was copied', 'This window cannot access the clipboard.');
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="pds-code">
      <div className="pds-code__bar">
        <span className="pds-code__language">{language ?? 'code'}</span>
        <button
          type="button"
          className="pds-code__copy"
          aria-label={copied ? 'Code copied' : 'Copy code'}
          onClick={() => {
            void copy();
          }}
        >
          {copied ? <CheckIcon className="pds-code__copy-icon" /> : <CopyIcon className="pds-code__copy-icon" />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className="pds-code__pre">{children}</pre>
    </div>
  );
}

/**
 * Markdown is rendered without raw HTML: no `rehype-raw`, no
 * `dangerouslySetInnerHTML` anywhere. Links leave through the external-link
 * policy and a `javascript:` or plain-HTTP link is rendered as text instead of
 * an anchor.
 *
 * Images are **always** replaced with their alt text. This is not a
 * `data:`-only filter: model output cannot be trusted to name an image source
 * the renderer is allowed to fetch, and the renderer performs no network I/O at
 * all (`connect-src 'none'`), so a remote image could only fail silently. A
 * generated image is therefore never delivered through Markdown — it is shown
 * from a media record the app wrote itself.
 */
const COMPONENTS: Components = {
  a: ({ href, children }) => {
    const url = typeof href === 'string' ? href : '';
    if (!isExternalLinkAllowed(url)) {
      return (
        <span className="pds-md-blocked">
          {children}
          <span className="pds-md-blocked__flag"> (link blocked)</span>
        </span>
      );
    }
    return (
      <a
        href={url}
        rel="noreferrer noopener"
        onClick={(event) => {
          event.preventDefault();
          void openExternalLink(url);
        }}
      >
        {children}
        <ExternalLinkIcon className="pds-md-external" />
      </a>
    );
  },
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  img: ({ alt }) => {
    // No image from model output is loaded: a remote URL would be a network
    // request, and the renderer makes none. The alt text still tells the reader
    // what was there.
    const label = typeof alt === 'string' && alt.length > 0 ? `“${alt}”` : 'An image';
    return (
      <span className="pds-md-image-blocked">{label} was not loaded: images are blocked.</span>
    );
  },
};

export interface MarkdownProps {
  content: string;
}

export function Markdown({ content }: MarkdownProps): ReactElement {
  return (
    <div className="pds-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
