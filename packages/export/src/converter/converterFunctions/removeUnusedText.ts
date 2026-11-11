export const removeUnusedText = (description: string, removeTitle: boolean = true) => {
  // remove \r
  description = description.replace(/\r/g, '')
  // remove comments basically same as /* comment */
  description = description.replace(/\/\*[^]*\*\/\n?/g, '')
  // remove comments basically same as // comment
  description = description.replace(/^ *?\/\/.*$\n?| +\/\/.*$/gm, '')
  // remove hidden exports // normal exports stay in description but not hidden
  description = description.replace(/^export hidden .* \([^]*?\n\)$/gm, '')
  // remove line with export name (
  description = description.replace(/^export .* \( *$\n/gm, '')
  // remove line with enhanced (
  description = description.replace(/^enhanced \($\n/gm, '')
  if (removeTitle) {
    // remove titles content
    description = description.replace(/\n?^title .+ \([^]*?\n\)$/gm, '')
    // remove ) and new line before it
    description = description.replace(/\n^\) *$/gm, '')
  }
  // remove variable declarations
  description = description.replace(/^var .* = .+$\n?/gm, '')
  // replace 3x+ \n with 2x \n
  description = description.replace(/\n\n\n+/gm, '\n\n')

  return description.trim()
}
