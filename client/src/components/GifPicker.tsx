import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useGiphy } from "../hooks/useGiphy";
import type { Gif } from "../hooks/useGiphy";

interface GifPickerProps {
  onSelect: (url: string) => void;
  onClose: () => void;
}

export default function GifPicker({ onSelect, onClose }: GifPickerProps) {
  const [query, setQuery] = useState("");
  const { gifs, loading, hasMore, search, loadMore, reset } = useGiphy();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Load trending on mount
  useEffect(() => {
    search("");
    return () => reset();
  }, [search, reset]);

  // Debounced search
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      search(query);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, search]);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    if (!sentinelRef.current || !gridRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          loadMore();
        }
      },
      { root: gridRef.current, threshold: 0.1 },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, loading, loadMore]);

  const handleSelect = useCallback(
    (gif: Gif) => {
      onSelect(gif.url);
      onClose();
    },
    [onSelect, onClose],
  );

  // Split gifs into two columns by distributing based on cumulative height
  const [col1, col2] = useMemo(() => {
    const a: Gif[] = [];
    const b: Gif[] = [];
    let hA = 0;
    let hB = 0;
    for (const gif of gifs) {
      const ratio = gif.previewHeight / (gif.previewWidth || 1);
      if (hA <= hB) {
        a.push(gif);
        hA += ratio;
      } else {
        b.push(gif);
        hB += ratio;
      }
    }
    return [a, b];
  }, [gifs]);

  const renderColumn = (items: Gif[]) =>
    items.map((gif) => (
      <div
        key={gif.id}
        className="gif-picker-item"
        onClick={() => handleSelect(gif)}
        title={gif.title}
      >
        <img src={gif.previewUrl} alt={gif.title} loading="lazy" />
      </div>
    ));

  return (
    <div className="gif-picker">
      <div className="gif-picker-header">
        <input
          className="gif-picker-search"
          type="text"
          placeholder="Search GIFs..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>
      <div className="gif-picker-grid" ref={gridRef}>
        <div className="gif-picker-column">{renderColumn(col1)}</div>
        <div className="gif-picker-column">{renderColumn(col2)}</div>
        <div ref={sentinelRef} className="gif-picker-sentinel" />
        {loading && (
          <div className="gif-picker-loading">Loading...</div>
        )}
      </div>
      <div className="gif-picker-footer">
        <img
          src="https://giphy.com/static/img/poweredby_giphy.png"
          alt="Powered by GIPHY"
          className="gif-picker-attribution"
        />
      </div>
    </div>
  );
}
