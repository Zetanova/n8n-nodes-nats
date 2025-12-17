import { ICredentialDataDecryptedObject, ICredentialTestFunctions, ICredentialsDecrypted, INodeCredentialTestResult } from "n8n-workflow";
import { Authenticator, ConnectionOptions, connect, credsAuthenticator, jwtAuthenticator, nkeyAuthenticator, tokenAuthenticator, usernamePasswordAuthenticator } from "nats";

export function natsConnectionOptions(credentials: ICredentialDataDecryptedObject): ConnectionOptions {
	let { authType, tlsEnabled, user, pass, token, seed, jwtSeed, jwt, creds, tlsCa, tlsCert, tlsKey, ...options } = credentials

	const authenticators: Authenticator[] = []

	//legacy compatibility
	if(!authType) {
		if(user && (user as string).length > 0) {
			authType = 'user'
		} else if(token && (token as string).length > 0) {
			authType = 'token'
		} else if(seed && (seed as string).length > 0) {
			authType = 'nkey'
		} else if(jwt && (jwt as string).length > 0) {
			authType = 'jwt'
		} else if(creds && (creds as string).length > 0) {
			authType = 'creds'
		} else if(tlsCert || tlsKey) {
			authType = 'tls'
		} else {
			authType = 'none'
		}
	}

	// If TLS is enabled, ensure that the CA certificate is provided
	if (tlsEnabled) {
		options.tls = { ca: tlsCa }
	}

	switch (authType) {
		case 'none':
			 break
		case 'user':
			authenticators.push(usernamePasswordAuthenticator(user as string, pass && (pass as string).length > 0 ? pass as string : undefined))
			break
		case 'token':
			authenticators.push(tokenAuthenticator(token as string))
			break
		case 'nkey':
			authenticators.push(nkeyAuthenticator(new TextEncoder().encode(seed as string)))
		  break
		case 'jwt':
			authenticators.push(jwtAuthenticator(jwt as string, (jwtSeed && (jwtSeed as string).length > 0) ? new TextEncoder().encode(jwtSeed as string) : undefined))
		  break
		case 'creds':
			authenticators.push(credsAuthenticator(new TextEncoder().encode(creds as string)))
		  break
		case 'tls':
			options.tls = { ca: tlsCa, cert: tlsCert, key: tlsKey }
		  break
	}

	return { ...options, authenticator: authenticators }
}

export async function natsCredTest(this: ICredentialTestFunctions, credential: ICredentialsDecrypted): Promise<INodeCredentialTestResult> {
	if(!credential.data) {
		return {
			status: 'Error',
			message: `Credential data is required`,
		}
	}

	try {
		const options = natsConnectionOptions(credential.data)
		const nats = await connect(options)
		await nats.rtt()
		await nats.close()
	} catch (error) {
		return {
			status: 'Error',
			message: `Settings are not valid or authentification failed: ${error}`,
		};
	}
	return {
		status: 'OK',
		message: 'Authentication successful!',
	};
}
