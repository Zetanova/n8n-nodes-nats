import { describe, it, expect } from 'vitest';
import { natsConnectionOptions } from '../common';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';

// ─── Helpers ─────────────────────────────────────────────────────

function creds(overrides: Record<string, unknown> = {}): ICredentialDataDecryptedObject {
	return { servers: 'nats://localhost:4222', ...overrides } as ICredentialDataDecryptedObject;
}

// ─── Tests ───────────────────────────────────────────────────────

describe('natsConnectionOptions', () => {

	// --- Auth type: none ---

	it('should return empty authenticator array for authType=none', () => {
		const opts = natsConnectionOptions(creds({ authType: 'none' }));
		expect(opts.authenticator).toEqual([]);
	});

	// --- Auth type: user/pass ---

	it('should add usernamePasswordAuthenticator for authType=user', () => {
		const opts = natsConnectionOptions(creds({ authType: 'user', user: 'admin', pass: 'secret' }));
		expect(opts.authenticator).toHaveLength(1);
	});

	it('should handle user auth with empty pass (treated as undefined)', () => {
		const opts = natsConnectionOptions(creds({ authType: 'user', user: 'admin', pass: '' }));
		expect(opts.authenticator).toHaveLength(1);
	});

	// --- Auth type: token ---

	it('should add tokenAuthenticator for authType=token', () => {
		const opts = natsConnectionOptions(creds({ authType: 'token', token: 'my-token' }));
		expect(opts.authenticator).toHaveLength(1);
	});

	// --- Auth type: nkey ---

	it('should add nkeyAuthenticator for authType=nkey', () => {
		const opts = natsConnectionOptions(creds({ authType: 'nkey', seed: 'SUACQKL3X3Y7JNQO3BNLSKN' }));
		expect(opts.authenticator).toHaveLength(1);
	});

	// --- Auth type: jwt ---

	it('should add jwtAuthenticator for authType=jwt', () => {
		const opts = natsConnectionOptions(creds({ authType: 'jwt', jwt: 'ey.jwt.token' }));
		expect(opts.authenticator).toHaveLength(1);
	});

	it('should add jwtAuthenticator with seed for authType=jwt', () => {
		const opts = natsConnectionOptions(creds({ authType: 'jwt', jwt: 'ey.jwt.token', jwtSeed: 'SUACQKL3X3Y7JNQO3BNLSKN' }));
		expect(opts.authenticator).toHaveLength(1);
	});

	// --- Auth type: creds ---

	it('should add credsAuthenticator for authType=creds', () => {
		const opts = natsConnectionOptions(creds({ authType: 'creds', creds: '-----BEGIN NATS CREDS-----' }));
		expect(opts.authenticator).toHaveLength(1);
	});

	// --- Auth type: tls ---

	it('should set tls options for authType=tls', () => {
		const opts = natsConnectionOptions(creds({
			authType: 'tls',
			tlsCa: 'ca-cert',
			tlsCert: 'client-cert',
			tlsKey: 'client-key',
		}));
		expect(opts.authenticator).toEqual([]);
		expect(opts.tls).toEqual({ ca: 'ca-cert', cert: 'client-cert', key: 'client-key' });
	});

	// --- TLS enabled (separate from tls auth) ---

	it('should set tls.ca when tlsEnabled is true', () => {
		const opts = natsConnectionOptions(creds({ authType: 'none', tlsEnabled: true, tlsCa: 'ca-cert' }));
		expect(opts.tls).toEqual({ ca: 'ca-cert' });
	});

	// --- Legacy compatibility (no authType field) ---

	it('should infer authType=user when user field is present (legacy)', () => {
		const opts = natsConnectionOptions(creds({ user: 'admin', pass: 'secret' }));
		expect(opts.authenticator).toHaveLength(1);
	});

	it('should infer authType=token when token field is present (legacy)', () => {
		const opts = natsConnectionOptions(creds({ token: 'my-token' }));
		expect(opts.authenticator).toHaveLength(1);
	});

	it('should infer authType=nkey when seed field is present (legacy)', () => {
		const opts = natsConnectionOptions(creds({ seed: 'SUACQKL3X3Y7JNQO3BNLSKN' }));
		expect(opts.authenticator).toHaveLength(1);
	});

	it('should infer authType=none when no auth fields present (legacy)', () => {
		const opts = natsConnectionOptions(creds({}));
		expect(opts.authenticator).toEqual([]);
	});

	// --- Empty string normalization ---

	it('should strip empty string options from result', () => {
		const opts = natsConnectionOptions(creds({ authType: 'none', name: '', verbose: '' }));
		expect(opts).not.toHaveProperty('name');
		expect(opts).not.toHaveProperty('verbose');
	});

	// --- Server URL parsing ---

	it('should pass servers through to options', () => {
		const opts = natsConnectionOptions(creds({ authType: 'none', servers: 'nats://host1:4222,nats://host2:4222' }));
		expect(opts.servers).toBe('nats://host1:4222,nats://host2:4222');
	});
});
