/**
 * The bridge contract for updates.
 *
 * Two things are asserted here that a unit test on the service cannot:
 *
 *  1. the channel table is what the preload and the renderer both read, so a
 *     renamed channel is caught once instead of at runtime;
 *  2. the only input any update channel accepts is a boolean — there is no field
 *     through which a renderer could point the updater at a different feed, ask
 *     for a specific version, or skip a step.
 */
import { describe, expect, it } from 'vitest';
import { IPC } from '@shared/api';
import { updateAutoCheckSchema } from '@shared/schemas';
import { UPDATE_STATUSES, UPDATE_STATUS_LABEL } from '@shared/updates';

describe('update channels', () => {
  it('are namespaced and distinct from every other channel', () => {
    const channels = Object.values(IPC);
    expect(new Set(channels).size).toBe(channels.length);

    const updateChannels = channels.filter((channel) => channel.startsWith('updates:'));
    expect(updateChannels.sort()).toEqual(
      [
        'updates:check',
        'updates:download',
        'updates:event',
        'updates:install',
        'updates:set-auto-check',
        'updates:state',
      ].sort(),
    );
  });

  it('send the state to the renderer on a dedicated event channel', () => {
    expect(IPC.updatesEvent).toBe('updates:event');
  });
});

describe('the only update input', () => {
  it('accepts a boolean and nothing else', () => {
    expect(updateAutoCheckSchema.parse(true)).toBe(true);
    expect(updateAutoCheckSchema.parse(false)).toBe(false);
    expect(() => updateAutoCheckSchema.parse('true')).toThrow();
    expect(() => updateAutoCheckSchema.parse({ enabled: true })).toThrow();
    expect(() => updateAutoCheckSchema.parse(null)).toThrow();
  });
});

describe('update states', () => {
  it('has a label for every state, so the panel can never render an empty line', () => {
    for (const status of UPDATE_STATUSES) {
      expect(UPDATE_STATUS_LABEL[status]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('covers the states the owner asked for', () => {
    // checking, up to date, available, downloading, ready, failed
    for (const status of ['checking', 'not-available', 'available', 'downloading', 'ready', 'error']) {
      expect(UPDATE_STATUSES).toContain(status);
    }
  });

  it('distinguishes "cannot check" from "check failed"', () => {
    /*
     * These are different user stories: one is a development build where retrying
     * will never help, the other is a network blip. Collapsing them would leave the
     * UI offering a pointless retry, or hiding a fixable failure.
     */
    expect(UPDATE_STATUSES).toContain('unsupported');
    expect(UPDATE_STATUSES).toContain('error');
  });
});
