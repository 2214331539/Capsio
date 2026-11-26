import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { emptyWorkspace } from '../domain/workspace';
import { createWorkspaceStore } from '../stores/workspace';
import type { WorkspaceBackend } from '../platform/desktop';
import { openRecommendationsEvent } from '../features/recommendations/briefs';
import { Notifications } from './Notifications';

afterEach(cleanup);

it("leads to the open project's recommendations, with nothing new as well", () => {
  const store = createWorkspaceStore({} as WorkspaceBackend);
  store.setState({ data: emptyWorkspace() });
  const opened = vi.fn();
  const listen = (event: Event) => opened((event as CustomEvent).detail);
  window.addEventListener(openRecommendationsEvent, listen);
  render(
    <Notifications
      store={store}
      projectId="p"
      onOpenRemote={async () => {}}
      onOpenSource={() => {}}
      onSyncSettings={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '通知' }));
  expect(screen.getByText('没有需要处理的事项')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '推荐' }));
  expect(opened).toHaveBeenCalledWith({ projectId: 'p', item: undefined });
  window.removeEventListener(openRecommendationsEvent, listen);
});
