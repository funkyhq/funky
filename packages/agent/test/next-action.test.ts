import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  StopReason,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@funky/core";
import { nextAction } from "../src/next-action";

const user = (): UserMessage => ({
  role: "user",
  content: [{ type: "text", text: "hi" }],
});

const assistant = (
  stopReason: StopReason,
  content: AssistantMessage["content"] = [],
): AssistantMessage => ({
  role: "assistant",
  content,
  model: "test-model",
  stopReason,
});

const toolCall = (id: string): ToolCall => ({
  type: "toolCall",
  id,
  name: "echo",
  arguments: {},
});

const toolResult = (isError = false): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: "c1",
  toolName: "echo",
  content: [{ type: "text", text: "ok" }],
  isError,
});

const live = false;
const cancelled = true;

describe("nextAction", () => {
  describe("after a user message", () => {
    it("starts the run with inference", () => {
      expect(nextAction(user(), live)).toEqual({ kind: "inference" });
    });
  });

  describe("after inference", () => {
    it("ends the run completed on end_turn without tool calls", () => {
      const action = nextAction(assistant("end_turn", [{ type: "text", text: "hi" }]), live);
      expect(action).toEqual({ kind: "end_run", status: "completed" });
    });

    it("schedules tool execution with the message's calls, in order", () => {
      const calls = [toolCall("c1"), toolCall("c2")];
      expect(nextAction(assistant("tool_use", calls), live)).toEqual({
        kind: "execute_tools",
        calls,
      });
    });

    it("executes on tool calls even when stopReason says end_turn", () => {
      expect(nextAction(assistant("end_turn", [toolCall("c1")]), live)).toEqual({
        kind: "execute_tools",
        calls: [toolCall("c1")],
      });
    });

    it("ends the run completed on tool_use with no calls in the content", () => {
      expect(nextAction(assistant("tool_use"), live)).toEqual({
        kind: "end_run",
        status: "completed",
      });
    });

    it("ends the run on max_tokens without executing the truncated calls", () => {
      expect(nextAction(assistant("max_tokens", [toolCall("c1")]), live)).toEqual({
        kind: "end_run",
        status: "max_tokens",
      });
    });

    it("ends the run cancelled on an aborted message", () => {
      expect(nextAction(assistant("aborted"), live)).toEqual({
        kind: "end_run",
        status: "cancelled",
      });
    });

    it("surfaces a provider error for the driver to decide", () => {
      expect(nextAction(assistant("error"), live)).toEqual({ kind: "error" });
    });
  });

  describe("after tool execution", () => {
    it("feeds tool results back into inference", () => {
      expect(nextAction(toolResult(), live)).toEqual({ kind: "inference" });
    });

    it("feeds error results back into inference too", () => {
      expect(nextAction(toolResult(true), live)).toEqual({ kind: "inference" });
    });
  });

  describe("cancel overlay", () => {
    it("outranks pending tool calls", () => {
      expect(nextAction(assistant("tool_use", [toolCall("c1")]), cancelled)).toEqual({
        kind: "end_run",
        status: "cancelled",
      });
    });

    it("outranks the tool-results-to-inference row", () => {
      expect(nextAction(toolResult(), cancelled)).toEqual({
        kind: "end_run",
        status: "cancelled",
      });
    });

    it("outranks a run start — cancel can race intake", () => {
      expect(nextAction(user(), cancelled)).toEqual({ kind: "end_run", status: "cancelled" });
    });

    it("outranks a provider error — a cancelled run is never retried", () => {
      expect(nextAction(assistant("error"), cancelled)).toEqual({
        kind: "end_run",
        status: "cancelled",
      });
    });
  });
});
