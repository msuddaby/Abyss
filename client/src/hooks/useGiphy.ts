import { useState, useRef, useCallback } from "react";

const API_KEY = import.meta.env.VITE_GIPHY_API_KEY as string;
const BASE = "https://api.giphy.com/v1/gifs";
const LIMIT = 25;

interface GiphyImage {
  url: string;
  width: string;
  height: string;
}

interface GiphyGif {
  id: string;
  title: string;
  images: {
    fixed_width: GiphyImage;
    original: GiphyImage;
  };
}

export interface Gif {
  id: string;
  title: string;
  previewUrl: string;
  previewWidth: number;
  previewHeight: number;
  url: string;
}

function mapGif(g: GiphyGif): Gif {
  return {
    id: g.id,
    title: g.title,
    previewUrl: g.images.fixed_width.url,
    previewWidth: parseInt(g.images.fixed_width.width, 10),
    previewHeight: parseInt(g.images.fixed_width.height, 10),
    url: g.images.original.url,
  };
}

export function useGiphy() {
  const [gifs, setGifs] = useState<Gif[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const offsetRef = useRef(0);
  const queryRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);

  const fetchGifs = useCallback(async (query: string, offset: number, append: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const endpoint = query ? `${BASE}/search` : `${BASE}/trending`;
    const params = new URLSearchParams({
      api_key: API_KEY,
      limit: String(LIMIT),
      offset: String(offset),
      ...(query ? { q: query } : {}),
    });

    setLoading(true);
    try {
      const res = await fetch(`${endpoint}?${params}`, { signal: controller.signal });
      const json = await res.json();
      const mapped = (json.data as GiphyGif[]).map(mapGif);
      setGifs((prev) => (append ? [...prev, ...mapped] : mapped));
      setHasMore(mapped.length >= LIMIT);
      offsetRef.current = offset + mapped.length;
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("Giphy fetch error:", err);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  const search = useCallback((query: string) => {
    queryRef.current = query;
    offsetRef.current = 0;
    setHasMore(true);
    fetchGifs(query, 0, false);
  }, [fetchGifs]);

  const loadMore = useCallback(() => {
    if (loading) return;
    fetchGifs(queryRef.current, offsetRef.current, true);
  }, [loading, fetchGifs]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    queryRef.current = "";
    offsetRef.current = 0;
    setGifs([]);
    setHasMore(true);
    setLoading(false);
  }, []);

  return { gifs, loading, hasMore, search, loadMore, reset };
}
