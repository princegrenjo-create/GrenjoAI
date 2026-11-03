import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AttachmentMeta, AttachmentPickResult } from '@shared/attachments';
import type { ModelCapabilities } from '@shared/types';
import { resetStores } from './helpers/state';
import { makeAttachment, makeModel } from './helpers/fake-api';
import { renderConversation } from './helpers/render-chat';

function pickResult(
  attachments: AttachmentMeta[],
  rejected: AttachmentPickResult['rejected'] = [],
): AttachmentPickResult {
  return { attachments, rejected, cancelled: false };
}

const VISION: ModelCapabilities = {
  chat: true,
  streaming: true,
  imageInput: true,
  toolCalling: true,
};

beforeEach(() => {
  resetStores();
});

describe('Composer attachments', () => {
  it('adds a chip with the file name, type and size from the picker', async () => {
    const harness = await renderConversation();
    await screen.findByText('This conversation is empty');

    harness.fake.mocks.attachmentsPick.mockResolvedValueOnce(
      pickResult([
        makeAttachment({
          id: 'a1',
          kind: 'text',
          name: 'brief.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 2048,
        }),
      ]),
    );

    await harness.user.click(harness.attachFileButton());

    await waitFor(() => expect(harness.fake.api.attachments.pick).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('brief.pdf')).toBeInTheDocument();
    expect(screen.getByText('Document · 2.0 KB')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove brief.pdf' })).toBeInTheDocument();
  });

  it('removes a chip through the attachment service', async () => {
    const harness = await renderConversation();
    await screen.findByText('This conversation is empty');

    harness.fake.mocks.attachmentsPick.mockResolvedValueOnce(
      pickResult([makeAttachment({ id: 'a1', name: 'brief.pdf' })]),
    );

    await harness.user.click(harness.attachFileButton());
    await screen.findByText('brief.pdf');

    await harness.user.click(screen.getByRole('button', { name: 'Remove brief.pdf' }));

    await waitFor(() => expect(harness.fake.api.attachments.remove).toHaveBeenCalledWith('a1'));
    await waitFor(() => expect(screen.queryByText('brief.pdf')).toBeNull());
  });

  it('explains a rejected file and keeps the accepted ones', async () => {
    const harness = await renderConversation();
    await screen.findByText('This conversation is empty');

    harness.fake.mocks.attachmentsPick.mockResolvedValueOnce(
      pickResult(
        [
          makeAttachment({ id: 'a1', name: 'brief.pdf' }),
          makeAttachment({ id: 'a2', name: 'budget.csv', mimeType: 'text/csv' }),
        ],
        [{ name: 'huge.zip', reason: 'Files must be 25 MB or smaller.' }],
      ),
    );

    await harness.user.click(harness.attachFileButton());

    expect(await screen.findByText('brief.pdf')).toBeInTheDocument();
    expect(screen.getByText('budget.csv')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('huge.zip');
    expect(alert).toHaveTextContent('Files must be 25 MB or smaller.');
  });

  it('sends the attachment ids in the order they were attached, with empty text', async () => {
    const harness = await renderConversation();
    await screen.findByText('This conversation is empty');

    harness.fake.mocks.attachmentsPick.mockResolvedValueOnce(
      pickResult([
        makeAttachment({ id: 'a1', name: 'first.txt' }),
        makeAttachment({ id: 'a2', name: 'second.txt' }),
      ]),
    );

    await harness.user.click(harness.attachFileButton());
    await screen.findByText('first.txt');
    expect(harness.sendButton()).toBeEnabled();

    await harness.user.click(harness.sendButton());

    await waitFor(() =>
      expect(harness.fake.api.chat.send).toHaveBeenCalledWith({
        conversationId: 'c1',
        content: '',
        attachmentIds: ['a1', 'a2'],
      }),
    );

    // The composer clears its chips; the sent turn keeps them.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove first.txt' })).toBeNull(),
    );
    expect(screen.getByText('second.txt')).toBeInTheDocument();
  });

  it('keeps a text-only send free of an attachmentIds field', async () => {
    const harness = await renderConversation();
    await screen.findByText('This conversation is empty');

    await harness.user.type(harness.textarea(), 'hello');
    await harness.user.click(harness.sendButton());

    await waitFor(() => expect(harness.fake.api.chat.send).toHaveBeenCalledTimes(1));
    const [payload] = harness.fake.mocks.chatSend.mock.calls[0] ?? [];
    expect(payload).toEqual({ conversationId: 'c1', content: 'hello' });
    expect(payload).not.toHaveProperty('attachmentIds');
  });

  it('blocks an image for a model that cannot read images, naming the model', async () => {
    const harness = await renderConversation();
    await screen.findByText('This conversation is empty');

    harness.fake.mocks.attachmentsPick.mockResolvedValueOnce(
      pickResult([
        makeAttachment({
          id: 'a1',
          kind: 'image',
          name: 'whiteboard.png',
          mimeType: 'image/png',
          sizeBytes: 4096,
          previewDataUrl: 'data:image/png;base64,AAAA',
        }),
      ]),
    );

    await harness.user.click(harness.attachImageButton());
    await screen.findByText('whiteboard.png');

    const warning = await screen.findByText(/DeepSeek Chat can’t accept images\./);
    expect(warning).toBeInTheDocument();
    expect(harness.sendButton()).toBeDisabled();

    await harness.user.type(harness.textarea(), 'What is this?');
    await harness.user.keyboard('{Enter}');
    expect(harness.fake.api.chat.send).not.toHaveBeenCalled();
  });

  it('offers the model picker as the way out of the image-capability warning', async () => {
    const harness = await renderConversation();
    await screen.findByText('This conversation is empty');

    harness.fake.mocks.attachmentsPick.mockResolvedValueOnce(
      pickResult([
        makeAttachment({ id: 'a1', kind: 'image', name: 'whiteboard.png', mimeType: 'image/png' }),
      ]),
    );

    await harness.user.click(harness.attachImageButton());
    await screen.findByText(/can’t accept images\./);

    await harness.user.click(screen.getByRole('button', { name: 'Choose a model' }));

    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveFocus();
  });

  it('sends the same image when the selected model accepts image input', async () => {
    const harness = await renderConversation({
      models: [makeModel({ displayName: 'DeepSeek Vision', capabilities: VISION })],
    });
    await screen.findByText('This conversation is empty');

    harness.fake.mocks.attachmentsPick.mockResolvedValueOnce(
      pickResult([
        makeAttachment({ id: 'a1', kind: 'image', name: 'whiteboard.png', mimeType: 'image/png' }),
      ]),
    );

    await harness.user.click(harness.attachImageButton());
    await screen.findByText('whiteboard.png');

    expect(screen.queryByText(/can’t accept images\./)).toBeNull();
    expect(harness.sendButton()).toBeEnabled();

    await harness.user.click(harness.sendButton());

    await waitFor(() =>
      expect(harness.fake.api.chat.send).toHaveBeenCalledWith({
        conversationId: 'c1',
        content: '',
        attachmentIds: ['a1'],
      }),
    );
  });

  it('says so when a file’s contents were not read', async () => {
    const harness = await renderConversation();
    await screen.findByText('This conversation is empty');

    harness.fake.mocks.attachmentsPick.mockResolvedValueOnce(
      pickResult([
        makeAttachment({
          id: 'a1',
          name: 'scan.bin',
          mimeType: 'application/octet-stream',
          kind: 'unsupported',
          contentStatus: 'metadata-only',
          contentNote: 'Only the file name and size are available to the model.',
          sentToProvider: false,
        }),
      ]),
    );

    await harness.user.click(harness.attachFileButton());
    await screen.findByText('scan.bin');

    expect(screen.getByText('Contents not read')).toBeInTheDocument();
    expect(
      screen.getByText('Only the file name and size are available to the model.'),
    ).toBeInTheDocument();
  });

  it('stops at the per-message count and explains the file that did not fit', async () => {
    const harness = await renderConversation();
    await screen.findByText('This conversation is empty');

    const eight = Array.from({ length: 8 }, (_, index) =>
      makeAttachment({ id: `a${index}`, name: `note-${index}.txt` }),
    );
    harness.fake.mocks.attachmentsPick
      .mockResolvedValueOnce(pickResult(eight))
      .mockResolvedValueOnce(pickResult([makeAttachment({ id: 'a9', name: 'one-more.txt' })]));

    await harness.user.click(harness.attachFileButton());
    await screen.findByText('note-7.txt');
    await harness.user.click(harness.attachFileButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('one-more.txt');
    expect(alert).toHaveTextContent('A message can carry 8 files at most.');
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(8);
  });

  it('reads a dropped file in the renderer and ingests its bytes', async () => {
    const harness = await renderConversation();
    await screen.findByText('This conversation is empty');

    const file = new File(['hello'], 'drop.txt', { type: 'text/plain' });
    const form = document.querySelector('form.pds-composer');
    expect(form).not.toBeNull();

    fireEvent.dragOver(form as HTMLFormElement, {
      dataTransfer: { types: ['Files'], files: [file] },
    });
    expect(screen.getByText('Drop files to attach them')).toBeInTheDocument();

    fireEvent.drop(form as HTMLFormElement, {
      dataTransfer: { types: ['Files'], files: [file] },
    });

    await waitFor(() =>
      expect(harness.fake.api.attachments.ingestBytes).toHaveBeenCalledWith({
        name: 'drop.txt',
        mimeType: 'text/plain',
        dataBase64: 'aGVsbG8=',
        kindHint: 'file',
      }),
    );
    expect(await screen.findByText('drop.txt')).toBeInTheDocument();
    expect(screen.getByText('Document · 5 B')).toBeInTheDocument();
  });

  it('refuses a dropped file that is past the size limit, with the reason', async () => {
    const harness = await renderConversation();
    await screen.findByText('This conversation is empty');

    const file = new File(['x'], 'enormous.zip', { type: 'application/zip' });
    Object.defineProperty(file, 'size', { value: 26 * 1024 * 1024 });
    const form = document.querySelector('form.pds-composer');

    fireEvent.drop(form as HTMLFormElement, {
      dataTransfer: { types: ['Files'], files: [file] },
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('enormous.zip');
    expect(alert).toHaveTextContent('Files must be 25 MB or smaller.');
    expect(harness.fake.api.attachments.ingestBytes).not.toHaveBeenCalled();
  });
});

describe('Composer attachment buttons', () => {
  it('asks the picker for a different kind from each button', async () => {
    const harness = await renderConversation();
    await screen.findByText('This conversation is empty');

    harness.fake.mocks.attachmentsPick
      .mockResolvedValueOnce(
        pickResult([
          makeAttachment({ id: 'f1', kind: 'text', name: 'brief.pdf', mimeType: 'application/pdf' }),
        ]),
      )
      .mockResolvedValueOnce(
        pickResult([
          makeAttachment({ id: 'i1', kind: 'image', name: 'chart.png', mimeType: 'image/png' }),
        ]),
      );

    await harness.user.click(harness.attachFileButton());
    await screen.findByText('brief.pdf');
    await harness.user.click(harness.attachImageButton());
    await screen.findByText('chart.png');

    // The defect being fixed: both buttons used to call `pick()` identically.
    expect(harness.fake.mocks.attachmentsPick.mock.calls).toEqual([
      [{ kinds: 'file' }],
      [{ kinds: 'image' }],
    ]);
    expect(harness.fake.mocks.attachmentsPick).toHaveBeenCalledTimes(2);
  });

  it('still shows the chip the image picker returned', async () => {
    const harness = await renderConversation();
    await screen.findByText('This conversation is empty');

    harness.fake.mocks.attachmentsPick.mockResolvedValueOnce(
      pickResult([
        makeAttachment({ id: 'i1', kind: 'image', name: 'chart.png', mimeType: 'image/png' }),
      ]),
    );

    await harness.user.click(harness.attachImageButton());

    await waitFor(() =>
      expect(harness.fake.mocks.attachmentsPick).toHaveBeenCalledWith({ kinds: 'image' }),
    );
    expect(await screen.findByText('chart.png')).toBeInTheDocument();
  });

  it('leaves the composer unchanged when the picker is cancelled', async () => {
    const harness = await renderConversation();
    await screen.findByText('This conversation is empty');

    harness.fake.mocks.attachmentsPick.mockResolvedValueOnce({
      attachments: [],
      rejected: [],
      cancelled: true,
    });

    await harness.user.click(harness.attachFileButton());

    await waitFor(() => expect(harness.fake.api.attachments.pick).toHaveBeenCalledTimes(1));
    expect(screen.queryAllByRole('button', { name: /^Remove / })).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(harness.sendButton()).toBeDisabled();
  });
});
