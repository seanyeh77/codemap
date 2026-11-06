// The design system bundle is a UMD file that reads React from window: set the globals,
// then load it (AGENTS.md, "Projects with a build step").
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import './vendor/ui-design-system/tokens.css'
import './vendor/ui-design-system/bundle.css'

Object.assign(window, { React, ReactDOM: { ...ReactDOM, ...ReactDOMClient } })
// @ts-expect-error: a UMD file; its types come from index.d.ts
await import('./vendor/ui-design-system/bundle.js')

/** SeanYeh's design system components, typed by vendor/ui-design-system/index.d.ts. */
export const UI = window.UI
