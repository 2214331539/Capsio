import test from 'node:test';
import assert from 'node:assert/strict';
import { upstreamUrl } from '../src/openalex.mjs';

test('works requests go to OpenAlex with the key, and nothing else does', () => {
  const search = new URLSearchParams('filter=cites:W1|W2&per-page=5&api_key=theirs');
  const target = upstreamUrl('/v1/openalex/works', search, 'ours');
  assert.equal(target.origin, 'https://api.openalex.org');
  assert.equal(target.pathname, '/works');
  assert.equal(target.searchParams.get('filter'), 'cites:W1|W2');
  assert.equal(target.searchParams.get('api_key'), 'ours', 'the caller cannot pass a key of its own');
  assert.equal(
    upstreamUrl('/v1/openalex/works/https://doi.org/10.1/abc', new URLSearchParams(), 'k').href,
    'https://api.openalex.org/works/https://doi.org/10.1/abc?api_key=k',
  );
  for (const path of ['/v1/openalex/authors', '/v1/openalex/works/../authors', '/v1/openalex/']) {
    assert.equal(upstreamUrl(path, new URLSearchParams(), 'k'), null, path);
  }
});
