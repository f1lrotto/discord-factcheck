import pino, { type DestinationStream } from 'pino';

export const createAppLogger = (input: {
  level: 'info' | 'error';
  environment: 'development' | 'test' | 'production';
  instanceKey: string;
  deploymentId?: string;
  destination?: DestinationStream;
}) =>
  pino(
    {
      level: input.level,
      base: {
        service: 'jolanda-discord-bot',
        version: '1.0.0',
        environment: input.environment,
        instanceKey: input.instanceKey,
        ...(input.deploymentId ? { deploymentId: input.deploymentId } : {}),
      },
      redact: {
        paths: [
          'authorization',
          'Authorization',
          'token',
          'apiKey',
          'requestBody',
          'messages',
          'content',
          '*.authorization',
          '*.Authorization',
          '*.token',
          '*.apiKey',
          '*.requestBody',
          '*.messages',
          '*.content',
        ],
        censor: '[REDACTED]',
      },
      ...(input.environment === 'development' && !input.destination
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, singleLine: true },
            },
          }
        : {}),
    },
    input.destination,
  );
