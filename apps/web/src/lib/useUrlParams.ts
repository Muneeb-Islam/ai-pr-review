import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";

/** Reads and updates query-string filters. An empty value removes the key, so the address stays short. */
export function useUrlParams() {
  const [params, setParams] = useSearchParams();
  const update = (changes: Record<string, string>) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );
  return { params, update, clear: () => setParams({}, { replace: true }) };
}

/**
 * A typed filter that is applied to the address shortly after the last keystroke (so every key does not
 * start a request). Follows the address when it changes from elsewhere (back, clear).
 */
export function useDebouncedParam(
  value: string,
  apply: (next: string) => void,
  delayMs = 300,
): [string, (next: string) => void] {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => apply(text.trim()), delayMs);
    return () => clearTimeout(timer);
    // `apply` changes every render; only the text and the applied value matter.
  }, [text, value, delayMs]);
  return [text, setText];
}
