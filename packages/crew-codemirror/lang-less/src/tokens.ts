import {ExternalTokenizer} from "@lezer/lr"
import {openArgList, descendantOp, Unit} from "./less.grammar.terms"

const space = [9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197,
               8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288]
const enum Ch {
  colon = 58, parenL = 40, underscore = 95, bracketL = 91, dash = 45, period = 46,
  hash = 35, percent = 37
}

function isAlpha(ch: number) { return ch >= 65 && ch <= 90 || ch >= 97 && ch <= 122 || ch >= 161 }

function isDigit(ch: number) { return ch >= 48 && ch <= 57 }

export const argList = new ExternalTokenizer((input, stack) => {
  if (input.next == Ch.parenL) {
    let prev = input.peek(-1)
    if (isAlpha(prev) || isDigit(prev) || prev == Ch.underscore || prev == Ch.dash)
      input.acceptToken(openArgList, 1)
  }
})

export const descendant = new ExternalTokenizer(input => {
  if (space.indexOf(input.peek(-1)) > -1) {
    let {next} = input
    if (isAlpha(next) || next == Ch.underscore || next == Ch.hash || next == Ch.period ||
        next == Ch.bracketL || next == Ch.colon || next == Ch.dash)
      input.acceptToken(descendantOp)
  }
})

export const unitToken = new ExternalTokenizer(input => {
  if (space.indexOf(input.peek(-1)) < 0) {
    let {next} = input
    if (next == Ch.percent) { input.advance(); input.acceptToken(Unit) }
    if (isAlpha(next)) {
      do { input.advance() } while (isAlpha(input.next))
      input.acceptToken(Unit)
    }
  }
})
