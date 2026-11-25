import type { Token } from "marked";

export function readSpec(file: string): {
  title: string;
  sections: Map<string, Token[]>;
};

export function readVariants(file: string, tokens: Token[], keys: string[]): {
  key: string;
  label: string;
  body: Token[];
}[];
