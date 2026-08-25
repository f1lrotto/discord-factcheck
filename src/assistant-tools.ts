import { z } from 'zod';
import { calculate } from './calculator.js';
import { timeZoneIsSupported, zonedDateTime, type ClockSnapshot } from './clock.js';
import {
  maximumToolArgumentCharacters,
  maximumToolResultCharacters,
  webFetchMaxContentTokens,
  webFetchMaxUses,
  webSearchMaxResults,
  webSearchResultCharacters,
} from './limits.js';

export type AssistantFunctionToolCall = {
  id: string;
  name: string;
  arguments: string;
};

type FunctionToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type ServerToolDefinition = {
  type: `openrouter:${string}`;
  parameters?: Record<string, unknown>;
};

export type AssistantToolDefinition = FunctionToolDefinition | ServerToolDefinition;

const calculatorInput = z.object({ expression: z.string().trim().min(1).max(256) }).strict();

const absoluteInstant = z
  .string()
  .max(64)
  .refine(
    (value) => /(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value)),
    'Expected an ISO 8601 instant with Z or an explicit UTC offset',
  );

const timeZoneInput = z
  .object({
    time_zone: z.string().trim().min(1).max(100).refine(timeZoneIsSupported),
    instant: absoluteInstant.optional(),
  })
  .strict();

const functionDefinitions = [
  {
    type: 'function',
    function: {
      name: 'calculate',
      description:
        'Evaluate deterministic, bounded numeric arithmetic. Use this instead of doing arithmetic mentally. Supports +, -, *, /, %, ^, parentheses, pi, e, and sqrt/abs/round/floor/ceil/min/max/pow/log/ln/sin/cos/tan.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          expression: {
            type: 'string',
            description: 'A bounded arithmetic expression, for example "(1250 * 0.23) + 49".',
          },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_datetime_in_timezone',
      description:
        'Get the current turn instant, or a supplied absolute ISO 8601 instant, represented in an exact IANA time zone with its weekday and UTC offset. Use for exact time-zone questions and daylight-saving-aware conversion.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          time_zone: {
            type: 'string',
            description: 'IANA time zone such as "Europe/Bratislava" or "America/New_York".',
          },
          instant: {
            type: 'string',
            description:
              'Optional absolute ISO 8601 instant with Z or an explicit offset. Omit to use the trusted turn clock.',
          },
        },
        required: ['time_zone'],
      },
    },
  },
] as const satisfies readonly FunctionToolDefinition[];

const publicWebTools = [
  {
    type: 'openrouter:web_search',
    parameters: {
      engine: 'exa',
      max_results: webSearchMaxResults,
      max_total_results: webSearchMaxResults,
      max_characters: webSearchResultCharacters,
    },
  },
  {
    type: 'openrouter:web_fetch',
    parameters: {
      engine: 'exa',
      max_uses: webFetchMaxUses,
      max_content_tokens: webFetchMaxContentTokens,
      blocked_domains: [
        '0.0.0.0',
        '127.0.0.1',
        '169.254.169.254',
        'localhost',
        'metadata.google.internal',
      ],
    },
  },
] as const satisfies readonly ServerToolDefinition[];

const toolError = (code: string) => JSON.stringify({ ok: false, error: code });

const boundedResult = (value: unknown) => {
  const result = JSON.stringify(value);
  return result.length <= maximumToolResultCharacters ? result : toolError('tool_result_too_large');
};

const parseArguments = (value: string) => {
  if (!value || value.length > maximumToolArgumentCharacters) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

export const createAssistantToolbox = (input: {
  clock: ClockSnapshot;
  allowFunctions: boolean;
}) => {
  const definitions: AssistantToolDefinition[] = [
    {
      type: 'openrouter:datetime',
      parameters: { timezone: input.clock.timeZone },
    },
    ...(input.allowFunctions ? functionDefinitions : []),
    ...publicWebTools,
  ];

  const execute = (call: AssistantFunctionToolCall) => {
    const arguments_ = parseArguments(call.arguments);
    if (arguments_ === undefined) return toolError('invalid_tool_arguments');
    try {
      if (call.name === 'calculate') {
        const parsed = calculatorInput.safeParse(arguments_);
        if (!parsed.success) return toolError('invalid_calculator_arguments');
        return boundedResult({ ok: true, ...calculate(parsed.data.expression) });
      }
      if (call.name === 'get_datetime_in_timezone') {
        const parsed = timeZoneInput.safeParse(arguments_);
        if (!parsed.success) return toolError('invalid_timezone_arguments');
        const instant = parsed.data.instant
          ? new Date(parsed.data.instant)
          : new Date(input.clock.instant);
        return boundedResult({ ok: true, ...zonedDateTime(instant, parsed.data.time_zone) });
      }
      return toolError('unknown_tool');
    } catch {
      return toolError('tool_execution_failed');
    }
  };

  return {
    definitions,
    execute,
    offered: definitions.map((definition) =>
      definition.type === 'function' ? definition.function.name : definition.type,
    ),
  };
};
