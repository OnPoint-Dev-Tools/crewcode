import {lessLanguage} from "@codemirror/lang-less"

let strict = lessLanguage.parser.configure({strict: true})

describe("Less parsing", () => {
  let cases = [`// Variables
@link-color:        #428bca; // sea blue
@link-color-hover:  darken(@link-color, 10%);

// Usage
a,
.link {
  color: @link-color;
}
a:hover {
  color: @link-color-hover;
}
.widget {
  color: #fff;
  background: @link-color;
}`, `@property: color;

.widget {
  @{property}: #0ee;
  background-@{property}: #999;
}`, `@primary:  green;
@secondary: blue;

.section {
  @color: primary;

  .element {
    color: @@color;
  }
}`, `// Properties as variables
.widget {
  color: #efefef;
  background-color: $color;
}
`, `// Parent selector join
.button {
  &-ok {
    background-image: url("ok.png");
  }
}`, `.a:extend(.b) {}

// the above block does the same thing as the below block
.a {
  &:extend(.b);
}`, `pre:hover,
.some-class {
  &:extend(div pre);
}`, `:nth-child(1n+3) {
  color: blue;
}
.child:extend(:nth-child(n+3)) {}`, `// Merge
.mixin() {
  box-shadow+: inset 0 0 10px #555;
}
.myclass {
  .mixin();
  box-shadow+_: 0 0 20px black;
}`, `// Guarded namespace
#namespace when (@mode = huge) {
  .mixin() { /* */ }
}

#namespace {
  .mixin() when (@mode = huge) { /* */ }
}`, `.foo (@bg: #f5f5f5; @color: #900) {
  background: @bg;
  color: @color;
}
.unimportant {
  .foo();
}
.important {
  .foo() !important;
}`, `// Named parameters
.mixin(@color: black; @margin: 10px; @padding: 20px) {
  color: @color;
  margin: @margin;
  padding: @padding;
}
.class1 {
  .mixin(@margin: 20px; @color: #33acfe);
}
.class2 {
  .mixin(#efca44; @padding: 40px);
}`, `.mixin(...) {}
.mixin() {}
.mixin(@a: 1) {}
.mixin(@a: 1, ...) {}
.mixin(@a, ...) {}
.mixin(@b...) {}`, `// Mixin guards
.mixin(@a) when (lightness(@a) >= 50%) {
  background-color: black;
}
.mixin(@a) when (lightness(@a) < 50%) {
  background-color: white;
}
.mixin(@a) {
  color: @a;
}`, `// Logic ops
.mixin(@a) when (isnumber(@a)) and not (@a > 0) { }`, `// Aliasing
#theme.dark.navbar {
  .colors(light) {
    primary: purple;
  }
  .colors(dark) {
    primary: black;
    secondary: grey;
  }
}

.navbar {
  @colors: #theme.dark.navbar.colors(dark);
  background: @colors[primary];
  border: 1px solid @colors[secondary];
}`, `// Variable calls
#library() {
  .colors() {
    background: green;
  }
}
.box {
  @alias: #library.colors();
  @alias();
}`, `// declare detached ruleset
@detached-ruleset: { background: red; }; // semi-colon is optional in 3.5.0+

// use detached ruleset
.top {
    @detached-ruleset(); 
}`, `@import (less) "foo.css";`, `@plugin "my-plugin";`, `// Detached without semi
@name: { font-face: sad; }
div { line-height: 2 }
`]
  for (let text of cases)
    it(/^.*/.exec(text)![0], () => strict.parse(text))
})
