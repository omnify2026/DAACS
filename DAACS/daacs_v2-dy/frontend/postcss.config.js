import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";

const fixMissingFrom = () => ({
  postcssPlugin: "daacs-fix-missing-from",
  Once(root) {
    const fallbackInput = root.source?.input ?? { file: "inline" };
    if (!fallbackInput.file) {
      fallbackInput.file = fallbackInput.id || "inline";
    }
    root.walkDecls((decl) => {
      if (!decl.source) {
        decl.source = { input: fallbackInput };
      } else if (!decl.source.input) {
        decl.source.input = fallbackInput;
      }
      if (!decl.source.input.file) {
        decl.source.input.file = fallbackInput.file;
      }
    });
  },
});
fixMissingFrom.postcss = true;

export default {
  plugins: [tailwindcss(), autoprefixer(), fixMissingFrom()],
};
