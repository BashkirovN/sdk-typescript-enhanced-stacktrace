import { checkExtends, hasOwnProperties, isRecord } from '@temporalio/internal-workflow-common';
import type { temporal } from '@temporalio/proto';
import { PayloadConverter, arrayFromPayloads, fromPayloadsAtIndex, toPayloads } from './converter/payload-converter';

export const FAILURE_SOURCE = 'TypeScriptSDK';
export type ProtoFailure = temporal.api.failure.v1.IFailure;

// Avoid importing the proto implementation to reduce workflow bundle size
// Copied from temporal.api.enums.v1.TimeoutType
export enum TimeoutType {
  TIMEOUT_TYPE_UNSPECIFIED = 0,
  TIMEOUT_TYPE_START_TO_CLOSE = 1,
  TIMEOUT_TYPE_SCHEDULE_TO_START = 2,
  TIMEOUT_TYPE_SCHEDULE_TO_CLOSE = 3,
  TIMEOUT_TYPE_HEARTBEAT = 4,
}

checkExtends<temporal.api.enums.v1.TimeoutType, TimeoutType>();

// Avoid importing the proto implementation to reduce workflow bundle size
// Copied from temporal.api.enums.v1.RetryState
export enum RetryState {
  RETRY_STATE_UNSPECIFIED = 0,
  RETRY_STATE_IN_PROGRESS = 1,
  RETRY_STATE_NON_RETRYABLE_FAILURE = 2,
  RETRY_STATE_TIMEOUT = 3,
  RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED = 4,
  RETRY_STATE_RETRY_POLICY_NOT_SET = 5,
  RETRY_STATE_INTERNAL_SERVER_ERROR = 6,
  RETRY_STATE_CANCEL_REQUESTED = 7,
}

checkExtends<temporal.api.enums.v1.RetryState, RetryState>();

export type WorkflowExecution = temporal.api.common.v1.IWorkflowExecution;

/**
 * Represents failures that can cross Workflow and Activity boundaries.
 *
 * Only exceptions that extend this class will be propagated to the caller.
 *
 * **Never extend this class or any of its derivatives.** They are to be used by the SDK code
 * only. Throw an instance {@link ApplicationFailure} to pass application specific errors between
 * Workflows and Activities.
 *
 * Any unhandled exception thrown by an Activity or Workflow will be converted to an instance of
 * {@link ApplicationFailure}.
 */
export class TemporalFailure extends Error {
  public readonly name: string = 'TemporalFailure';
  /**
   * The original failure that constructed this error.
   *
   * Only present if this error was generated from an external operation.
   */
  public failure?: ProtoFailure;

  constructor(message: string | undefined, public readonly cause?: Error) {
    super(message ?? undefined);
  }
}

/** Exceptions originated at the Temporal service. */
export class ServerFailure extends TemporalFailure {
  public readonly name: string = 'ServerFailure';

  constructor(message: string | undefined, public readonly nonRetryable: boolean, cause?: Error) {
    super(message, cause);
  }
}

/**
 * `ApplicationFailure`s are used to communicate application-specific failures in Workflows and Activities.
 *
 * The {@link type} property is matched against {@link RetryPolicy.nonRetryableErrorTypes} to determine if an instance
 * of this error is retryable. Another way to avoid retrying is by setting the {@link nonRetryable} flag to `true`.
 *
 * In Workflows, if you throw a non-`ApplicationFailure`, the Workflow Task will fail and be retried. If you throw an
 * `ApplicationFailure`, the Workflow Execution will fail.
 *
 * In Activities, you can either throw an `ApplicationFailure` or another `Error` to fail the Activity Task. In the
 * latter case, the `Error` will be converted to an `ApplicationFailure`. If the
 * {@link https://docs.temporal.io/concepts/what-is-an-activity-execution | Activity Execution} fails, the
 * `ApplicationFailure` from the last Activity Task will be the `cause` of the {@link ActivityFailure} thrown in the
 * Workflow.
 *
 * The conversion of an error that doesn't extend {@link TemporalFailure} to an `ApplicationFailure` is done as
 * following:
 *
 * - `type` is set to `error.constructor?.name ?? error.name`
 * - `message` is set to `error.message`
 * - `nonRetryable` is set to false
 * - `details` are set to null
 * - stack trace is copied from the original error
 */
export class ApplicationFailure extends TemporalFailure {
  public readonly name: string = 'ApplicationFailure';

  constructor(
    message: string | undefined,
    public readonly type: string | undefined | null,
    public readonly nonRetryable: boolean,
    public readonly details?: unknown[],
    cause?: Error
  ) {
    super(message, cause);
  }

  /**
   * Get a new `ApplicationFailure` with the {@link nonRetryable} flag set to false. Note that this error will still
   * not be retried if its `type` is included in {@link RetryPolicy.nonRetryableErrorTypes}.
   *
   * @param message Optional error message
   * @param type Optional error type (used by {@link RetryPolicy.nonRetryableErrorTypes})
   * @param details Optional details about the failure. Serialized by the Worker's {@link PayloadConverter}.
   */
  public static retryable(message: string | undefined, type?: string, ...details: unknown[]): ApplicationFailure {
    return new this(message, type ?? 'Error', false, details);
  }

  /**
   * Get a new `ApplicationFailure` with the {@link nonRetryable} flag set to true.
   *
   * When thrown from an Activity or Workflow, the Activity or Workflow will not be retried (even if `type` is not
   * listed in {@link RetryPolicy.nonRetryableErrorTypes}).
   *
   * @param message Optional error message
   * @param type Optional error type
   * @param details Optional details about the failure. Serialized by the Worker's {@link PayloadConverter}.
   */
  public static nonRetryable(message: string | undefined, type?: string, ...details: unknown[]): ApplicationFailure {
    return new this(message, type ?? 'Error', true, details);
  }
}

/**
 * This error is thrown when Cancellation has been requested. To allow Cancellation to happen, let it propagate. To
 * ignore Cancellation, catch it and continue executing. Note that Cancellation can only be requested a single time, so
 * your Workflow/Activity Execution will not receive further Cancellation requests.
 *
 * When a Workflow or Activity has been successfully cancelled, a `CancelledFailure` will be the `cause`.
 */
export class CancelledFailure extends TemporalFailure {
  public readonly name: string = 'CancelledFailure';

  constructor(message: string | undefined, public readonly details: unknown[] = [], cause?: Error) {
    super(message, cause);
  }
}

/**
 * Used as the `cause` when a Workflow has been terminated
 */
export class TerminatedFailure extends TemporalFailure {
  public readonly name: string = 'TerminatedFailure';

  constructor(message: string | undefined, cause?: Error) {
    super(message, cause);
  }
}

/**
 * Used to represent timeouts of Activities and Workflows
 */
export class TimeoutFailure extends TemporalFailure {
  public readonly name: string = 'TimeoutFailure';

  constructor(
    message: string | undefined,
    public readonly lastHeartbeatDetails: unknown,
    public readonly timeoutType: TimeoutType
  ) {
    super(message);
  }
}

/**
 * Contains information about an Activity failure. Always contains the original reason for the failure as its `cause`.
 * For example, if an Activity timed out, the cause will be a {@link TimeoutFailure}.
 *
 * This exception is expected to be thrown only by the framework code.
 */
export class ActivityFailure extends TemporalFailure {
  public readonly name: string = 'ActivityFailure';

  public constructor(
    public readonly activityType: string,
    public readonly activityId: string | undefined,
    public readonly retryState: RetryState,
    public readonly identity: string | undefined,
    cause?: Error
  ) {
    super('Activity execution failed', cause);
  }
}

/**
 * Contains information about a Child Workflow failure. Always contains the reason for the failure as its {@link cause}.
 * For example, if the Child was Terminated, the `cause` is a {@link TerminatedFailure}.
 *
 * This exception is expected to be thrown only by the framework code.
 */
export class ChildWorkflowFailure extends TemporalFailure {
  public readonly name: string = 'ChildWorkflowFailure';

  public constructor(
    public readonly namespace: string | undefined,
    public readonly execution: WorkflowExecution,
    public readonly workflowType: string,
    public readonly retryState: RetryState,
    cause?: Error
  ) {
    super('Child Workflow execution failed', cause);
  }
}

/**
 * Converts an error to a Failure proto message if defined or returns undefined
 */
export function optionalErrorToOptionalFailure(
  err: unknown,
  payloadConverter: PayloadConverter
): ProtoFailure | undefined {
  return err ? errorToFailure(err, payloadConverter) : undefined;
}

/**
 * Stack traces will be cutoff when on of these patterns is matched
 */
const CUTOFF_STACK_PATTERNS = [
  /** Activity execution */
  /\s+at Activity\.execute \(.*[\\/]worker[\\/](?:src|lib)[\\/]activity\.[jt]s:\d+:\d+\)/,
  /** Workflow activation */
  /\s+at Activator\.\S+NextHandler \(.*[\\/]workflow[\\/](?:src|lib)[\\/]internals\.[jt]s:\d+:\d+\)/,
  /** Workflow run anything in context */
  /\s+at Script\.runInContext \((?:node:vm|vm\.js):\d+:\d+\)/,
];

/**
 * Cuts out the framework part of a stack trace, leaving only user code entries
 */
export function cutoffStackTrace(stack?: string): string {
  const lines = (stack ?? '').split(/\r?\n/);
  const acc = Array<string>();
  lineLoop: for (const line of lines) {
    for (const pattern of CUTOFF_STACK_PATTERNS) {
      if (pattern.test(line)) break lineLoop;
    }
    acc.push(line);
  }
  return acc.join('\n');
}

/**
 * Converts a caught error to a Failure proto message
 */
export function errorToFailure(err: unknown, payloadConverter: PayloadConverter): ProtoFailure {
  if (err instanceof TemporalFailure) {
    if (err.failure) return err.failure;

    const base = {
      message: err.message,
      stackTrace: cutoffStackTrace(err.stack),
      cause: optionalErrorToOptionalFailure(err.cause, payloadConverter),
      source: FAILURE_SOURCE,
    };
    if (err instanceof ActivityFailure) {
      return {
        ...base,
        activityFailureInfo: {
          ...err,
          activityType: { name: err.activityType },
        },
      };
    }
    if (err instanceof ChildWorkflowFailure) {
      return {
        ...base,
        childWorkflowExecutionFailureInfo: {
          ...err,
          workflowExecution: err.execution,
          workflowType: { name: err.workflowType },
        },
      };
    }
    if (err instanceof ApplicationFailure) {
      return {
        ...base,
        applicationFailureInfo: {
          type: err.type,
          nonRetryable: err.nonRetryable,
          details:
            err.details && err.details.length ? { payloads: toPayloads(payloadConverter, ...err.details) } : undefined,
        },
      };
    }
    if (err instanceof CancelledFailure) {
      return {
        ...base,
        canceledFailureInfo: {
          details:
            err.details && err.details.length ? { payloads: toPayloads(payloadConverter, ...err.details) } : undefined,
        },
      };
    }
    if (err instanceof TimeoutFailure) {
      return {
        ...base,
        timeoutFailureInfo: {
          timeoutType: err.timeoutType,
          lastHeartbeatDetails: err.lastHeartbeatDetails
            ? { payloads: toPayloads(payloadConverter, err.lastHeartbeatDetails) }
            : undefined,
        },
      };
    }
    if (err instanceof TerminatedFailure) {
      return {
        ...base,
        terminatedFailureInfo: {},
      };
    }
    if (err instanceof ServerFailure) {
      return {
        ...base,
        serverFailureInfo: { nonRetryable: err.nonRetryable },
      };
    }
    // Just a TemporalFailure
    return base;
  }

  const base = {
    source: FAILURE_SOURCE,
  };

  if (isRecord(err) && hasOwnProperties(err, ['message', 'stack'])) {
    return {
      ...base,
      message: String(err.message) ?? '',
      stackTrace: cutoffStackTrace(String(err.stack)),
      cause: optionalErrorToOptionalFailure(err.cause, payloadConverter),
    };
  }

  const recommendation = ` [A non-Error value was thrown from your code. We recommend throwing Error objects so that we can provide a stack trace]`;

  if (typeof err === 'string') {
    return { ...base, message: err + recommendation };
  }
  if (typeof err === 'object') {
    let message = '';
    try {
      message = JSON.stringify(err);
    } catch (_err) {
      message = String(err);
    }
    return { ...base, message: message + recommendation };
  }

  return { ...base, message: String(err) + recommendation };
}

/**
 * If `err` is an Error it is turned into an `ApplicationFailure`.
 *
 * If `err` was already a `ApplicationFailure`, returns the original error.
 *
 * Otherwise returns an `ApplicationFailure` with `String(err)` as the message.
 */
export function ensureApplicationFailure(err: unknown): ApplicationFailure {
  if (err instanceof ApplicationFailure) {
    return err;
  }
  if (err instanceof Error) {
    const name = err.constructor?.name ?? err.name;
    const failure = new ApplicationFailure(err.message, name, false);
    failure.stack = err.stack;
    return failure;
  } else {
    const failure = new ApplicationFailure(String(err), undefined, false);
    failure.stack = '';
    return failure;
  }
}

/**
 * If `err` is an Error it is turned into an `ApplicationFailure`.
 *
 * If `err` was already a `TemporalFailure`, returns the original error.
 *
 * Otherwise returns an `ApplicationFailure` with `String(err)` as the message.
 */
export function ensureTemporalFailure(err: unknown): TemporalFailure {
  if (err instanceof TemporalFailure) {
    return err;
  }
  return ensureApplicationFailure(err);
}

/**
 * Converts a Failure proto message to a JS Error object if defined or returns undefined.
 */
export function optionalFailureToOptionalError(
  failure: ProtoFailure | undefined | null,
  payloadConverter: PayloadConverter
): TemporalFailure | undefined {
  return failure ? failureToError(failure, payloadConverter) : undefined;
}

/**
 * Converts a Failure proto message to a JS Error object.
 *
 * Does not set common properties, that is done in {@link failureToError}.
 */
export function failureToErrorInner(failure: ProtoFailure, payloadConverter: PayloadConverter): TemporalFailure {
  if (failure.applicationFailureInfo) {
    return new ApplicationFailure(
      failure.message ?? undefined,
      failure.applicationFailureInfo.type,
      Boolean(failure.applicationFailureInfo.nonRetryable),
      arrayFromPayloads(payloadConverter, failure.applicationFailureInfo.details?.payloads),
      optionalFailureToOptionalError(failure.cause, payloadConverter)
    );
  }
  if (failure.serverFailureInfo) {
    return new ServerFailure(
      failure.message ?? undefined,
      Boolean(failure.serverFailureInfo.nonRetryable),
      optionalFailureToOptionalError(failure.cause, payloadConverter)
    );
  }
  if (failure.timeoutFailureInfo) {
    return new TimeoutFailure(
      failure.message ?? undefined,
      fromPayloadsAtIndex(payloadConverter, 0, failure.timeoutFailureInfo.lastHeartbeatDetails?.payloads),
      failure.timeoutFailureInfo.timeoutType ?? TimeoutType.TIMEOUT_TYPE_UNSPECIFIED
    );
  }
  if (failure.terminatedFailureInfo) {
    return new TerminatedFailure(
      failure.message ?? undefined,
      optionalFailureToOptionalError(failure.cause, payloadConverter)
    );
  }
  if (failure.canceledFailureInfo) {
    return new CancelledFailure(
      failure.message ?? undefined,
      arrayFromPayloads(payloadConverter, failure.canceledFailureInfo.details?.payloads),
      optionalFailureToOptionalError(failure.cause, payloadConverter)
    );
  }
  if (failure.resetWorkflowFailureInfo) {
    return new ApplicationFailure(
      failure.message ?? undefined,
      'ResetWorkflow',
      false,
      arrayFromPayloads(payloadConverter, failure.resetWorkflowFailureInfo.lastHeartbeatDetails?.payloads),
      optionalFailureToOptionalError(failure.cause, payloadConverter)
    );
  }
  if (failure.childWorkflowExecutionFailureInfo) {
    const { namespace, workflowType, workflowExecution, retryState } = failure.childWorkflowExecutionFailureInfo;
    if (!(workflowType?.name && workflowExecution)) {
      throw new TypeError('Missing attributes on childWorkflowExecutionFailureInfo');
    }
    return new ChildWorkflowFailure(
      namespace ?? undefined,
      workflowExecution,
      workflowType.name,
      retryState ?? RetryState.RETRY_STATE_UNSPECIFIED,
      optionalFailureToOptionalError(failure.cause, payloadConverter)
    );
  }
  if (failure.activityFailureInfo) {
    if (!failure.activityFailureInfo.activityType?.name) {
      throw new TypeError('Missing activityType?.name on activityFailureInfo');
    }
    return new ActivityFailure(
      failure.activityFailureInfo.activityType.name,
      failure.activityFailureInfo.activityId ?? undefined,
      failure.activityFailureInfo.retryState ?? RetryState.RETRY_STATE_UNSPECIFIED,
      failure.activityFailureInfo.identity ?? undefined,
      optionalFailureToOptionalError(failure.cause, payloadConverter)
    );
  }
  return new TemporalFailure(
    failure.message ?? undefined,
    optionalFailureToOptionalError(failure.cause, payloadConverter)
  );
}

/**
 * Converts a Failure proto message to a JS Error object.
 */
export function failureToError(failure: ProtoFailure, payloadConverter: PayloadConverter): TemporalFailure {
  const err = failureToErrorInner(failure, payloadConverter);
  err.stack = failure.stackTrace ?? '';
  err.failure = failure;
  return err;
}

/**
 * Get the root cause message of given `error`.
 *
 * In case `error` is a {@link TemporalFailure}, recurse the `cause` chain and return the root `cause.message`.
 * Otherwise, return `error.message`.
 */
export function rootCause(error: unknown): string | undefined {
  if (error instanceof TemporalFailure) {
    return error.cause ? rootCause(error.cause) : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return undefined;
}
