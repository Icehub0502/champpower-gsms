// @vitest-environment happy-dom
/**
 * ApiError.body — additive only. A refusal's data (candidates, owner names,
 * missing fields) must be reachable; `message` must stay the error code
 * exactly as before, so every existing caller is unaffected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, publicApi, setAccessToken } from './client';

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function caught(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected the request to be refused');
}

describe('ApiError.body', () => {
  it('a 409 with a JSON body exposes the whole body; message is still the error code', async () => {
    const refusal = {
      error: 'customer_ambiguous',
      message: 'เบอร์นี้มีลูกค้ามากกว่าหนึ่งราย กรุณาเลือกว่าเป็นรายไหน',
      candidates: [{ id: '00000000-0000-4000-8000-000000000001', name: 'A' }],
    };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(refusal), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    );
    const err = await caught(api.post('/api/checkin', {}));
    expect(err.status).toBe(409);
    expect(err.message).toBe('customer_ambiguous');
    expect(err.body).toEqual(refusal);
  });

  it('a non-JSON error leaves body undefined and keeps the status-text message', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    const err = await caught(publicApi.get('/api/public/board/x'));
    expect(err.status).toBe(502);
    expect(err.message).toBe('Bad Gateway');
    expect(err.body).toBeUndefined();
  });

  it('a JSON body without an `error` field is still exposed, message falls back as before', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'x' }), { status: 400, statusText: 'Bad Request' }),
    );
    const err = await caught(publicApi.get('/api/public/board/x'));
    expect(err.message).toBe('Bad Request');
    expect(err.body).toEqual({ detail: 'x' });
  });
});

describe('api.upload', () => {
  afterEach(() => setAccessToken(null));

  function formWithFile() {
    const fd = new FormData();
    fd.append('kind', 'checkin_photo');
    fd.append('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'car.jpg');
    return fd;
  }

  it('POSTs the FormData as-is, with no Content-Type (the browser writes the boundary) and the token attached', async () => {
    setAccessToken('tok-1');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'f1' }), { status: 201 }));
    const fd = formWithFile();
    const res = await api.upload<{ id: string }>('/api/files', fd);
    expect(res).toEqual({ id: 'f1' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/files');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(fd);
    const headers = new Headers(init?.headers);
    expect(headers.has('Content-Type')).toBe(false);
    expect(headers.get('Authorization')).toBe('Bearer tok-1');
  });

  it('401 -> one refresh -> retry resends the SAME FormData with the new token', async () => {
    setAccessToken('expired');
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"unauthorized"}', { status: 401 })) // upload
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'fresh' }), { status: 200 })) // refresh
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'f2' }), { status: 201 })); // retry
    const fd = formWithFile();
    const res = await api.upload<{ id: string }>('/api/files', fd);
    expect(res).toEqual({ id: 'f2' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/auth/refresh');
    const first = fetchMock.mock.calls[0]![1]!;
    const retry = fetchMock.mock.calls[2]![1]!;
    expect(first.body).toBe(fd);
    expect(retry.body).toBe(fd);
    expect((retry.body as FormData).get('file')).toBeInstanceOf(Blob);
    expect(new Headers(retry.headers).get('Authorization')).toBe('Bearer fresh');
    expect(new Headers(retry.headers).has('Content-Type')).toBe(false);
  });

  it('JSON calls are unchanged: still Content-Type application/json with a stringified body', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await api.post('/api/checkin', { a: 1 });
    const init = fetchMock.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(init.body).toBe('{"a":1}');
  });
});
