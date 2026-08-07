import { LanguageSupport, LRLanguage } from '@codemirror/language';

/**
A syntax provider based on the [Lezer Rust
parser](https://code.haverbeke.berlin/lezer/rust), extended with
highlighting and indentation information.
*/
declare const rustLanguage: LRLanguage;
/**
Rust language support
*/
declare function rust(): LanguageSupport;

export { rust, rustLanguage };
