// The design system's rules (token colours, its components instead of native controls, ...) and React's rules of
// hooks. `npm run lint`.
import ui from '@seanyeh77/eslint-plugin-ui'
import hooks from 'eslint-plugin-react-hooks'

export default [
  { ignores: ['dist-pages/**', 'node_modules/**'] },
  {
    ...ui.configs.recommended,
    files: ['src/**/*.{ts,tsx}'],
    plugins: { ...ui.configs.recommended.plugins, 'react-hooks': hooks },
    rules: { ...ui.configs.recommended.rules, 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },
]
