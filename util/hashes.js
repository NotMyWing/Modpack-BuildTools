/**
 * Bytes to exclude from hashing.
 * 
 * Why? I dunno.
 */
const MURMUR_SKIP_BYTES = {
	9: true
	, 10: true
	, 13: true
	, 32: true
};

const murmurhashV2 = require('murmurhash').v2;

/**
 * Returns the hash sum of bytes of given bytes using MurmurHash v2.
 * 
 * This is what Twitch is using to fingerprint mod files.
 * 
 * @param {Buffer} inputBuffer Input Buffer
 * @param {number} [seed] Optional seed.
 * @returns {Number} The MurmurHash hash of file contents.
 */
exports.murmurhash = (inputBuffer, seed = 1) => {
	var buff = new Uint8Array(inputBuffer.length);
	var output = "";

	for (let i = 0; i < inputBuffer.length; i++) {
		const byte = inputBuffer.readUInt8(i);

		if (!MURMUR_SKIP_BYTES[byte]) {
			output += String.fromCharCode(byte);
		}
	}

	return murmurhashV2(output, 1);
};

const sha1 = require("sha1");

/**
 * Returns the hash sum of bytes of given bytes using SHA1.
 * 
 * This is what Forge is using to check files.
 * 
 * @param {Buffer} inputBuffer Input Buffer
 * @returns {Number} The SHA1 hash of file contents.
 */
exports.sha1 = (inputBuffer) => {
	return sha1(inputBuffer);
};
