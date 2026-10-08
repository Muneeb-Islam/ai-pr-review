/** A stand-in for the browser's EventSource that a test drives by hand (jsdom has none). */
type Listener = (event: Event | MessageEvent) => void;

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset(): void {
    FakeEventSource.instances = [];
  }
  static get last(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1);
    if (!last) throw new Error("No EventSource was opened");
    return last;
  }

  readyState = 0; // CONNECTING
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  // ----- test controls -----
  open(): void {
    this.readyState = 1;
    this.dispatch("open", new Event("open"));
  }

  message(type: string, data: unknown): void {
    this.dispatch(
      type,
      new MessageEvent(type, { data: typeof data === "string" ? data : JSON.stringify(data) }),
    );
  }

  /** The connection dropped; the browser keeps trying unless `giveUp` (a 401 or 503 answer). */
  fail(giveUp = false): void {
    this.readyState = giveUp ? 2 : 0;
    this.dispatch("error", new Event("error"));
  }

  private dispatch(type: string, event: Event | MessageEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export const asEventSource = FakeEventSource as unknown as typeof EventSource;
