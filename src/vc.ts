import { hexToBn } from '@polkadot/util'
import { base58Encode, base58Decode } from '@polkadot/util-crypto';
import dayjs from 'moment';

import * as Cord from '@cord.network/sdk';


type ContentPrimitives = string | number | boolean
export interface IContents {
  [key: string]:
    | ContentPrimitives
    | IContents
    | Array<ContentPrimitives | IContents>
}

export function calculateVCHash(vc: any): string {
    const {
	issuanceDate,
	validFrom,
	validUntil,
	issuer,
	credentialSubject
    } = vc;
    let newCredContent = { issuanceDate, validFrom, validUntil, issuer, credentialSubject };
    const serializedCred = Cord.Utils.Crypto.encodeObjectAsStr(newCredContent)
    const credHash = Cord.Utils.Crypto.hashStr(serializedCred)

    return credHash;
}


export async function addProof(
    vc: any,
    issuerKeys:  Cord.ICordKeyPair,
    issuerDid:  Cord.DidDocument,
    options: any
) {
    const now = dayjs();

    let credHash = calculateVCHash(vc);
    vc.credentialHash = credHash;
    /* proof 0 - Ed25519 */
    /* validates ownership by checking the signature against the DID */

    let signature = await issuerKeys.assertionMethod.sign(vc.credentialHash);
    let keyType = 'assertionMethod';
    let keyUri = `${issuerDid.uri}${
        issuerDid.assertionMethod![0].id
      }` as Cord.DidResourceUri;

    let proof0  = {
	"type": "Ed25519Signature2020",
	"created": now.toDate().toString(),
	"proofPurpose": keyType,
	"verificationMethod": keyUri,
	"proofValue": 'z' + base58Encode(signature),
    }

    /* proof 1 - CordProof */
    /* contains check for revoke */
    const statementEntry = Cord.Statement.buildFromProperties(
	vc.credentialHash,
	options.spaceUri!,
	issuerDid.uri,
	options.schemaUri ?? undefined
    )
    let elem = statementEntry.elementUri.split(':');
    let proof1 = {
	type: "CordProof2024",
	elementUri: statementEntry.elementUri,
	spaceUri: statementEntry.spaceUri,
	schemaUri: statementEntry.schemaUri,
	issuer: issuerDid.uri,
	digest: vc.credentialHash,
	identifier: `${elem[0]}:${elem[1]}:${elem[2]}`
    }

    vc['proof'] = [ proof0, proof1 ];

    /* TODO: Bring selective disclosure here */
    let proof2: any = undefined;
    if (options?.needSDR) {
	/* proof 2 - ConentNonces for selective disclosure */
	/* This will enable the selective disclosure. This may not be compatible with the normal VC */
	/* This also would change the 'credentialSubject' */
	vc.credentialSubject = {
	    id: vc.credentialSubject.id,
	    contents: []
	}
	proof2 = {
	    type: 'CordSelectiveDisclosureProof2023',
	}
    }
    if (proof2) vc.proof.push(proof2);

    return vc;
}


export async function verifyVC(vc: any) {
    /* assumption is one is getting the vc with proof here */
    let credHash =  calculateVCHash(vc);
    let identifier = vc.id;

    /* proof check */
    const proofs = vc.proof;

    for (let i = 0; i < proofs.length; i++) {
	let obj = proofs[i];
	if (!obj) continue;
	if (obj.type === 'CordProof2024') {
	    /* verify the proof */
	    
	    if (obj.digest !== credHash) {
	       throw 'credential Digest mismatch';
	    }
	    if (obj.elementUri !== `${obj.identifier}:${credHash.replace('0x','')}`) {
	       throw 'elementUri mismatch';
	    }

	    const verificationResult = await Cord.Statement.verifyAgainstProperties(
		obj.elementUri,
		obj.digest,
		obj.issuer,
		obj.spaceUri,
		obj.schemaUri,
	    )

	    if (!verificationResult.isValid) {
		throw 'Failed to verify CordProof2024';
	    }
	    /* all good, no throw */
	}
	if (obj.type === 'Ed25519Signature2020') {
	    let signature = obj.proofValue
	    /* this 'z' is from digitalbazaar/ed25519signature2020 project */
	    /* TODO: use the above package to verify the proof */
	    if (signature && signature[0] === 'z') {
		let str = signature.substr(1, signature.length);
		/* lets convert it to uint8array */
		signature = base58Decode(str);
	    }
	    await Cord.Did.verifyDidSignature({ message: credHash, signature, keyUri: obj.verificationMethod});
	    /* all is good, no throw */
        }
    }
}

function jsonLDcontents(
  contents: IContents,
  schemaId: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  const flattenedContents = Cord.Utils.DataUtils.flattenObject(contents || {});

  result['@context'] =  { '@vocab': `${schemaId}#` };

  Object.entries(flattenedContents).forEach(([key, value]) => {
    result[vocabulary + key] = value;
  });

  return result;
}

export function toJsonLD(
  contents: IContents,
  schemaId: string,
): Record<string, unknown> {
  const credentialSubject = jsonLDcontents(contents, schemaId)
    return credentialSubject;
}

function makeStatementsJsonLD(contents: IContents, schemaId: string): string[] {
  const normalized = jsonLDcontents(contents, schemaId)
  return Object.entries(normalized).map(([key, value]) =>
    JSON.stringify({ [key]: value })
  )
}

export function hashContents(
  contents: IContents,
  schemaId: string,
  options: Cord.Utils.Crypto.HashingOptions & {
    selectedAttributes?: string[],
  } = {}
): {
  hashes: Cord.HexString[]
  nonceMap: Record<string, string>
} {
  // use canonicalisation algorithm to make hashable statement strings
  const statements = makeStatementsJsonLD(contents, schemaId)

  let filteredStatements = statements
  if (options.selectedAttributes && options.selectedAttributes.length) {
    filteredStatements = Cord.Utils.DataUtils.filterStatements(statements, options.selectedAttributes);
  }

  // iterate over statements to produce salted hashes
  const processed = Cord.Utils.Crypto.hashStatements(filteredStatements, options)

  // produce array of salted hashes to add to credential
  const hashes = processed
    .map(({ saltedHash }) => saltedHash)
    .sort((a, b) => hexToBn(a).cmp(hexToBn(b)))

  // produce nonce map, where each nonce is keyed with the unsalted hash
  const nonceMap = {}
  processed.forEach(({ digest, nonce, statement }) => {
    // throw if we can't map a digest to a nonce - this should not happen if the nonce map is complete and the credential has not been tampered with
    if (!nonce) throw new Cord.Utils.SDKErrors.ContentNonceMapMalformedError(statement)
    nonceMap[digest] = nonce
  }, {})
  return { hashes, nonceMap }
}


export function buildVcFromContent(
  schema: Cord.ISchema,
  contents: IContents,
  issuer: Cord.DidDocument,
  holder: Cord.DidUri,
  options: any,
) {
    Cord.Schema.verifyObjectAgainstSchema(contents, schema)

    const { evidenceIds, validFrom, validUntil, templates, labels } = options

    const now = new Date();
    const issuanceDate = now.toISOString()
    const validFromString = validFrom ? validFrom.toISOString() : now.toISOString()
    const validUntilString = validUntil ? validUntil.toISOString() : new Date(new Date().setFullYear(now.getFullYear() + 1)).toISOString()

    const credentialSubject = {
	...contents,
	'@context':  { '@vocab': `${schema.$id}#` },
	id: holder,
    }
    let vc: any = {
	'@context': [
	    'https://www.w3.org/2018/credentials/v1',
	    'https://cord.network/2023/cred/v1'
	],
	type: ["VerifiableCredential"],
        issuer: issuer.uri,
	issuanceDate,
	credentialSubject,
	validFrom: validFromString,
	validUntil: validUntilString,
	metadata: {
	    evidence: evidenceIds,
	    template: templates,
	    label: labels,
	},
	credentialSchema: schema,
    }
    vc.credentialHash = calculateVCHash(vc);

  return vc;
}

