import { MongoServerError } from 'mongodb';

export const isDuplicateKey = (error: unknown) =>
  error instanceof MongoServerError && error.code === 11000;

export const bucketIds = (guildKey: string, date: Date) => {
  const iso = date.toISOString();
  const keys = { day: iso.slice(0, 10), month: iso.slice(0, 7) };
  return {
    day: `${guildKey}:day:${keys.day}`,
    month: `${guildKey}:month:${keys.month}`,
    keys,
  };
};
