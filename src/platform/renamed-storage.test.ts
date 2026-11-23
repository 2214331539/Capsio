import { beforeEach, expect, it } from 'vitest';
import { adoptRenamedStorage } from './renamed-storage';

beforeEach(() => localStorage.clear());

it('carries page state saved as Scientify over to Capsio once', () => {
  localStorage.setItem('scientify.reader.a1', '{"page":4}');
  localStorage.setItem('scientify.ui.v2', '{"tab":"scientify:runs"}');
  localStorage.setItem('capsio.projects.view', 'list');
  localStorage.setItem('scientify.projects.view', 'grid');
  adoptRenamedStorage();
  expect(localStorage.getItem('capsio.reader.a1')).toBe('{"page":4}');
  expect(localStorage.getItem('capsio.ui.v2')).toBe('{"tab":"capsio:runs"}');
  expect(localStorage.getItem('capsio.projects.view')).toBe('list');

  localStorage.setItem('scientify.reader.b2', '{"page":9}');
  adoptRenamedStorage();
  expect(localStorage.getItem('capsio.reader.b2')).toBeNull();
});
