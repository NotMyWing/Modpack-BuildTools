const { getVersionManifest } = require("./minecraft.js");
const request = require("request");

const LAUNCHERMETA_VERSION_MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest.json";

const promisifyRequest = (url) => {
	return new Promise((resolve, reject) => {
		request(url, (err, response, body) => {
			if (err || response.statusCode != 200) {
				reject(err);
			}

			resolve(body);
		})
	})
}

promisifyRequest(LAUNCHERMETA_VERSION_MANIFEST).then((body) => {
	const minecraftVersionsManifest = JSON.parse(body);

	if (minecraftVersionsManifest) {
		const versions = minecraftVersionsManifest.versions;

		const version = versions.find(x => x.id == "1.12.2");
		if (version) {
			promisifyRequest(version.url).then((body) => {
				const metadata = JSON.parse(body);

				if (metadata) {
					console.log(metadata.libraries);
				}
			});
		}
	}
})