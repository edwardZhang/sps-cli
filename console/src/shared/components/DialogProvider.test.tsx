import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DialogProvider, useDialog } from './DialogProvider';

function ConfirmHarness({ onResult }: { onResult: (v: boolean) => void }) {
  const { confirm } = useDialog();
  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await confirm({
          title: 'Delete?',
          body: 'Sure?',
          confirm: 'Delete',
          danger: true,
        });
        onResult(ok);
      }}
    >
      trigger
    </button>
  );
}

function PromptHarness({ onResult }: { onResult: (v: string | null) => void }) {
  const { prompt } = useDialog();
  return (
    <button
      type="button"
      onClick={async () => {
        const v = await prompt({ title: 'Name?', placeholder: 'xx' });
        onResult(v);
      }}
    >
      trigger
    </button>
  );
}

describe('DialogProvider', () => {
  it('confirm resolves true on confirm click, false on cancel click', async () => {
    const user = userEvent.setup();
    const results: boolean[] = [];

    render(
      <DialogProvider>
        <ConfirmHarness onResult={(v) => results.push(v)} />
      </DialogProvider>,
    );

    // First: click confirm
    await user.click(screen.getByText('trigger'));
    expect(screen.getByRole('heading', { name: 'Delete?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(results).toEqual([true]);

    // Dialog should be gone
    expect(screen.queryByRole('heading', { name: 'Delete?' })).not.toBeInTheDocument();

    // Second: click cancel
    await user.click(screen.getByText('trigger'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(results).toEqual([true, false]);
  });

  it('confirm false on Escape', async () => {
    const user = userEvent.setup();
    const results: boolean[] = [];

    render(
      <DialogProvider>
        <ConfirmHarness onResult={(v) => results.push(v)} />
      </DialogProvider>,
    );

    await user.click(screen.getByText('trigger'));
    await user.keyboard('{Escape}');
    expect(results).toEqual([false]);
  });

  it('prompt returns trimmed value on submit, null on cancel', async () => {
    const user = userEvent.setup();
    const results: Array<string | null> = [];

    render(
      <DialogProvider>
        <PromptHarness onResult={(v) => results.push(v)} />
      </DialogProvider>,
    );

    // Submit path
    await user.click(screen.getByText('trigger'));
    const input = screen.getByPlaceholderText('xx');
    await user.type(input, '  acme  ');
    await user.click(screen.getByRole('button', { name: 'OK' }));
    expect(results).toEqual(['acme']);

    // Cancel path
    await user.click(screen.getByText('trigger'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(results).toEqual(['acme', null]);
  });

  it('prompt disables submit button when value is empty', async () => {
    const user = userEvent.setup();
    const results: Array<string | null> = [];

    render(
      <DialogProvider>
        <PromptHarness onResult={(v) => results.push(v)} />
      </DialogProvider>,
    );

    await user.click(screen.getByText('trigger'));
    const submit = screen.getByRole('button', { name: 'OK' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByPlaceholderText('xx'), 'x');
    expect(submit).toBeEnabled();
  });

  it('only one dialog at a time — second call queues until first resolves', async () => {
    // Current behavior: calling confirm while one is open replaces the state.
    // Document that behavior so refactors know.
    const user = userEvent.setup();
    let firstResolve: ((v: boolean) => void) | null = null;

    function Harness() {
      const { confirm } = useDialog();
      return (
        <>
          <button
            onClick={async () => {
              const v = await confirm({ title: 'first', body: 'f' });
              firstResolve?.(v);
            }}
            type="button"
          >
            first
          </button>
          <button
            onClick={async () => {
              await confirm({ title: 'second', body: 's' });
            }}
            type="button"
          >
            second
          </button>
        </>
      );
    }

    render(
      <DialogProvider>
        <Harness />
      </DialogProvider>,
    );

    await user.click(screen.getByText('first'));
    expect(screen.getByRole('heading', { name: 'first' })).toBeInTheDocument();

    // Triggering second while first is open — UI replaces state (no queue)
    await act(async () => {
      await user.click(screen.getByText('second'));
    });
    expect(screen.queryByRole('heading', { name: 'first' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'second' })).toBeInTheDocument();
  });
});
