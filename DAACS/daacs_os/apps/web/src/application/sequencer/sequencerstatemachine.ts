export type SequencerState =
  | "Idle"
  | "Planning"
  | "TodoSync"
  | "StepExecuting"
  | "CommandExecuting"
  | "CascadeExecuting"
  | "Completed"
  | "Failed";

export class SequencerStateMachine {
  private state: SequencerState = "Idle";

  public GetState(): SequencerState {
    return this.state;
  }

  public Transit(InState: SequencerState): SequencerState {
    this.state = InState;
    return this.state;
  }
}
