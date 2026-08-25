export const formatUsd = (microdollars: number) => {
  const [dollars = '0', fractional = ''] = (microdollars / 1_000_000).toFixed(6).split('.');
  return `$${dollars}.${fractional.replace(/0+$/u, '').padEnd(4, '0')}`;
};
