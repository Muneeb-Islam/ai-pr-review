import { useEffect } from "react";

/** "Runs · AI PR Review": the tab title says where you are (and screen readers announce the change). */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · AI PR Review` : "AI PR Review";
  }, [title]);
}
