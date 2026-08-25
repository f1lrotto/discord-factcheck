import process from 'node:process';

const key = process.env.OPENROUTER_LIVE_TEST_KEY?.trim();

if (!key) {
  process.stderr.write(
    'OPENROUTER_LIVE_TEST_KEY is required for paid OpenRouter compatibility tests.\n',
  );
  process.exitCode = 1;
}
