/**
 * React context types.
 *
 * Types for React context providers in the application.
 */

import {type ReactNode} from 'react';
import {type UseFeedResult} from './useFeed';
import type {Runtime} from '../../core/runtime/types';
import type {WorkflowConfig} from '../../core/workflows/types';
import type {AthenaHarness} from '../../infra/plugins/config';
import type {RuntimeFactory} from '../runtime/createRuntime';

/**
 * Value provided by the HookContext.
 */
export type HookContextValue = UseFeedResult;

/**
 * Props for the HookProvider component.
 */
export type HookProviderProps = {
	projectDir: string;
	instanceId: number;
	harness: AthenaHarness;
	workflow?: WorkflowConfig;
	runtime?: Runtime;
	runtimeFactory?: RuntimeFactory;
	allowedTools?: string[];
	athenaSessionId: string;
	children: ReactNode;
};
