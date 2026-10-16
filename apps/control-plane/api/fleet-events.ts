/**
 * One-process metadata-only fleet event store for the local control plane.
 *
 * Task 7 of the identity-fleet plan needs an operator to see one registered
 * agent and its current run, and to stop it with a visible acknowledgement.
 * The ledger records tool-call *evidence*; this store records fleet *state
 * changes*, agent start, run start, tool decision, approval, dispatch result,
 * stop request, stop acknowledgement.
 *
 * Metadata-only by construction: the store's input type has no field that
 * could carry a token or prompt text. A caller cannot leak a bearer into the
 * feed by accident, because there is nowhere to put one.
 */

export type FleetEventKind =
  | "agent_started"
  | "run_started"
  | "tool_decision"
  | "approval"
  | "dispatch_result"
  | "stop_requested"
  | "stop_acknowledged";

export type FleetEventInput = {
  readonly kind: FleetEventKind;
  readonly agentId: string;
  readonly sessionId?: string;
  /** Short operator-facing label; never a prompt body. */
  readonly label: string;
  /** A bounded decision/approval verdict, e.g. "allow" | "deny" | "hold". */
  readonly verdict?: string;
  readonly at?: string;
};

export type FleetEvent = Required<Pick<FleetEventInput, "kind" | "agentId" | "label">> &
  FleetEventInput & {
    readonly seq: number;
    readonly at: string;
  };

const MAX_EVENTS = 500;

export class FleetEventStore {
  #events: FleetEvent[] = [];
  #seq = 0;
  // Dynamic per-session membership changes at runtime, so Map is the honest
  // shape; it is instance state, not a module global, so tests stay isolated.
  #ackBySession = new Map<string, "pending" | "acknowledged" | "unknown">();

  record(input: FleetEventInput): FleetEvent {
    this.#seq += 1;
    const event: FleetEvent = {
      ...input,
      seq: this.#seq,
      at: input.at ?? new Date().toISOString(),
    };
    this.#events.push(event);
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);

    if (input.kind === "stop_requested" && input.sessionId)
      this.#ackBySession.set(input.sessionId, "pending");
    if (input.kind === "stop_acknowledged" && input.sessionId)
      this.#ackBySession.set(input.sessionId, "acknowledged");

    return event;
  }

  /** Events after a sequence number, oldest first. */
  after(seq: number): FleetEvent[] {
    return this.#events.filter((event) => event.seq > seq);
  }

  latest(count: number): FleetEvent[] {
    return this.#events.slice(-count);
  }

  /** Stop acknowledgement state for a session: pending until a stop ack lands. */
  stopAck(sessionId: string | undefined): "pending" | "acknowledged" | "unknown" {
    if (sessionId === undefined) return "unknown";
    return this.#ackBySession.get(sessionId) ?? "unknown";
  }
}

/** Process-wide store for the one-process local demo. */
export const fleetEvents = new FleetEventStore();
