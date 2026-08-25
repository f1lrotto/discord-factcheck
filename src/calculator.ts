const maximumExpressionCharacters = 256;
const maximumTokens = 256;

type Token =
  | { type: 'number'; value: number }
  | { type: 'identifier'; value: string }
  | { type: 'operator'; value: '+' | '-' | '*' | '/' | '%' | '^' }
  | { type: 'left' | 'right' | 'comma' };

const numberPattern = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const identifierPattern = /[A-Za-z]+/y;

const tokenize = (expression: string) => {
  if (!expression.trim() || expression.length > maximumExpressionCharacters)
    throw new Error('Calculator expression is empty or too long');
  const tokens: Token[] = [];
  let cursor = 0;

  while (cursor < expression.length) {
    const character = expression[cursor];
    if (/\s/u.test(character ?? '')) {
      cursor += 1;
      continue;
    }
    numberPattern.lastIndex = cursor;
    const number = numberPattern.exec(expression);
    if (number) {
      const value = Number(number[0]);
      if (!Number.isFinite(value)) throw new Error('Calculator number is not finite');
      tokens.push({ type: 'number', value });
      cursor = numberPattern.lastIndex;
      continue;
    }
    identifierPattern.lastIndex = cursor;
    const identifier = identifierPattern.exec(expression);
    if (identifier) {
      tokens.push({ type: 'identifier', value: identifier[0].toLocaleLowerCase('en-US') });
      cursor = identifierPattern.lastIndex;
      continue;
    }
    if (['+', '-', '*', '/', '%', '^'].includes(character ?? ''))
      tokens.push({
        type: 'operator',
        value: character as Extract<Token, { type: 'operator' }>['value'],
      });
    else if (character === '(') tokens.push({ type: 'left' });
    else if (character === ')') tokens.push({ type: 'right' });
    else if (character === ',') tokens.push({ type: 'comma' });
    else throw new Error('Calculator expression contains an unsupported character');
    cursor += 1;
    if (tokens.length > maximumTokens) throw new Error('Calculator expression is too complex');
  }
  return tokens;
};

const constants: Record<string, number> = { e: Math.E, pi: Math.PI };

const applyFunction = (name: string, values: number[]) => {
  const unary: Record<string, (value: number) => number> = {
    abs: Math.abs,
    ceil: Math.ceil,
    cos: Math.cos,
    floor: Math.floor,
    ln: Math.log,
    log: Math.log10,
    round: Math.round,
    sin: Math.sin,
    sqrt: Math.sqrt,
    tan: Math.tan,
  };
  const unaryFunction = unary[name];
  if (unaryFunction && values.length === 1) return unaryFunction(values[0] ?? Number.NaN);
  if (name === 'pow' && values.length === 2) return Math.pow(values[0] ?? 0, values[1] ?? 0);
  if (name === 'min' && values.length >= 1 && values.length <= 20) return Math.min(...values);
  if (name === 'max' && values.length >= 1 && values.length <= 20) return Math.max(...values);
  throw new Error('Calculator function is unknown or has invalid arguments');
};

export const calculate = (expression: string) => {
  const tokens = tokenize(expression);
  let cursor = 0;
  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];

  const parsePrimary = (): number => {
    const token = take();
    if (!token) throw new Error('Calculator expression ended unexpectedly');
    if (token.type === 'number') return token.value;
    if (token.type === 'left') {
      const value = parseAdditive();
      if (take()?.type !== 'right')
        throw new Error('Calculator expression has unmatched parentheses');
      return value;
    }
    if (token.type !== 'identifier') throw new Error('Calculator expected a number');
    const constant = constants[token.value];
    if (constant !== undefined && peek()?.type !== 'left') return constant;
    if (take()?.type !== 'left') throw new Error('Calculator function requires parentheses');
    const values: number[] = [];
    if (peek()?.type !== 'right') {
      while (true) {
        values.push(parseAdditive());
        if (peek()?.type !== 'comma') break;
        take();
      }
    }
    if (take()?.type !== 'right') throw new Error('Calculator function has unmatched parentheses');
    return applyFunction(token.value, values);
  };

  const parsePower = (): number => {
    const base = parsePrimary();
    const token = peek();
    if (token?.type !== 'operator' || token.value !== '^') return base;
    take();
    return Math.pow(base, parseUnary());
  };

  const parseUnary = (): number => {
    const token = peek();
    if (token?.type !== 'operator' || !['+', '-'].includes(token.value)) return parsePower();
    take();
    const value = parseUnary();
    return token.value === '-' ? -value : value;
  };

  const parseMultiplicative = (): number => {
    let value = parseUnary();
    while (true) {
      const token = peek();
      if (token?.type !== 'operator' || !['*', '/', '%'].includes(token.value)) return value;
      take();
      const right = parseUnary();
      if (token.value === '*') value *= right;
      if (token.value === '/') value /= right;
      if (token.value === '%') value %= right;
    }
  };

  function parseAdditive() {
    let value = parseMultiplicative();
    while (true) {
      const token = peek();
      if (token?.type !== 'operator' || !['+', '-'].includes(token.value)) return value;
      take();
      const right = parseMultiplicative();
      value = token.value === '+' ? value + right : value - right;
    }
  }

  const value = parseAdditive();
  if (cursor !== tokens.length) throw new Error('Calculator expression has unexpected input');
  if (!Number.isFinite(value)) throw new Error('Calculator result is not finite');
  const result = Number(value.toPrecision(15));
  return { expression, result };
};
