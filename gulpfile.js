const { src, task, series, dest } = require("gulp");
const fs = require("fs");
const del = require("del");
const path = require("path");
const log = require("fancy-log")
const unzip = require("unzipper")
const Promise = require("bluebird");
const request = require("request");
const requestPromise = require("request-promise");

const MODPACK_MANIFEST = JSON.parse(fs.readFileSync("./modpack/manifest.json"));

const FORGE_MAVEN = "https://files.minecraftforge.net/maven/";
const MOJANG_MAVEN = "https://libraries.minecraft.net/";
const DEST_FOLDER = "./dest";
const TEMP_FOLDER = path.join(DEST_FOLDER, "temp");

const LIBRARY_REG = /^(.+?):(.+?):(.+?)$/;
const libraryToPath = (url, suffix) => {
	const parsedURL = LIBRARY_REG.exec(url);
	if (parsedURL) {
		const package = parsedURL[1].replace(/\./g, "/");
		const name = parsedURL[2];
		const version = parsedURL[3];

		if (suffix) {
			suffix = `-${suffix}`;
		} else {
			suffix = "";
		}
		const newURL = `${package}/${name}/${version}/${name}-${version}${suffix}.jar`

		return newURL;
	}
}

task("cleanup", (cb) => {
	del.sync("./dest/**");
	cb();
});

task("create-folders", (cb) => {
	const toCreate = [
		DEST_FOLDER,
		TEMP_FOLDER
	];

	toCreate.forEach((dir) => {
		log(`Creating folder ${path.normalize(dir)}`);
		fs.mkdirSync(path.resolve(dir), { recursive: true })
	});

	cb();
});

const downloadLibraries = (manifest, cb) => {
	const serverLibraries = manifest
		.versionInfo
		.libraries
		.filter(x => x.serverreq);

	Promise.all(serverLibraries.map((library) => {
		return new Promise((resolve) => {
			const libraryPath = libraryToPath(library.name);
			const localLibraryPath = path.join("./dest/libraries", libraryPath);
			const url = library.url || MOJANG_MAVEN;

			const directory = path.dirname(path.resolve(localLibraryPath));
			fs.mkdirSync(directory, { recursive: true });

			log("Downloading", url + libraryPath, "...")
			request(url + libraryPath)
				.pipe(fs.createWriteStream(localLibraryPath))
				.on("close", resolve);
		})
	})).then(() => {
		log("Finished downloading Forge libraries.")
		cb();
	})
}

const FORGE_VERSION_REG = /forge-(.+)/;
task("download-forge", (cb) => {
	const minecraft = MODPACK_MANIFEST.minecraft;
	const parsedForgeEntry = FORGE_VERSION_REG.exec(
		(minecraft.modLoaders
			.find(x => x.id && x.id.indexOf("forge") != -1
		) || {}).id || ""
	);

	if (parsedForgeEntry) {
		// Transform Forge version into Maven library
		const forgeMavenLibrary = `net.minecraftforge:forge:${minecraft.version}-${parsedForgeEntry[1]}`;
		const forgeInstallerPath = libraryToPath(forgeMavenLibrary, "installer");
		const forgeUniversalPath = libraryToPath(forgeMavenLibrary, "universal");
		const localForgePath = path.join(TEMP_FOLDER, path.basename(forgeInstallerPath));

		// Download the Forge installer
		log("Downloading", FORGE_MAVEN + forgeInstallerPath, "...")
		request(FORGE_MAVEN + forgeInstallerPath)
			.pipe(fs.createWriteStream(localForgePath))
			.on("close", () => {
				log("Extracting the Forge installer...")
				fs.createReadStream(localForgePath)
					.pipe(unzip.Extract({ path: path.join(TEMP_FOLDER, "forge") }))
					.on("close", () => {
						log("Reading the manifest file...")
						const manifest = JSON.parse(
							fs.readFileSync(path.join(TEMP_FOLDER, "forge", "install_profile.json"))
						);

						if (manifest && manifest.versionInfo && manifest.versionInfo.libraries) {
							log("Copying the Forge file...")
							fs.renameSync(
								path.join(TEMP_FOLDER, "forge", path.basename(forgeUniversalPath))
								, path.join(DEST_FOLDER, path.basename(forgeUniversalPath))
							);

							log("Fetching server libraries...")
							downloadLibraries(manifest, cb);
						} else {
							cb("Malformed Forge manifest file.")
						}
					});
			});
	}
});

task("post-cleanup", (cb) => {
	del(TEMP_FOLDER);
	cb();
})

const LAUNCHERMETA_VERSION_MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest.json";
task("download-minecraft-server", (cb) => {
	log("Fetching the Minecraft version manifest...")
	requestPromise({ uri: LAUNCHERMETA_VERSION_MANIFEST, json: true }).then((manifest) => {
		const version = manifest.versions.find(x => x.id == MODPACK_MANIFEST.minecraft.version);
		if (version) {
			log(`Fetching the manifest file for Minecraft ${version.id}...`)
			requestPromise({ uri: version.url, json: true }).then((versionManifest) => {
				const serverJarFile = `minecraft_server.${version.id}.jar`
				if (versionManifest.downloads && versionManifest.downloads.server) {
					log(`Downloading ${serverJarFile}...`);

					request(versionManifest.downloads.server.url)
						.pipe(fs.createWriteStream(path.join(DEST_FOLDER, serverJarFile)))
						.on("close", cb);
				} else {
					cb(`No server jar file found for ${version.id}`);
				}
			}).catch(cb);
		} else {
			cb(`Couldn't find ${MODPACK_MANIFEST.minecraft.version} in the version manifest.`);
		}
	});
});

task("download-mods", (cb) => {
	log("Fetching mods...");
	
	Promise.all(MODPACK_MANIFEST.files.map(file => {
		return requestPromise(`https://addons-ecs.forgesvc.net/api/v2/addon/${file.projectID}/file/${file.fileID}/download-url`)
	})).then(results => {
		log(`Fetched ${results.length} mod files, downloading...`);

		fs.mkdirSync(path.join(DEST_FOLDER, "mods"))

		var counter = 1;
		Promise.all(results.map(url => {
			return new Promise((resolve) => {
				const filename = path.join(DEST_FOLDER, "mods", path.basename(url));
				var attempts = 0;
				const retry = (previousErr) => {
					attempts++;

					if (attempts != 1) {
						log(`Error downloading ${path.basename(url)}: ${previousErr}. Retrying...`);
					} else if (attempts == 3) {
						cb(`Fatal error downloading ${path.basename(url)}: ${previousErr}`);
					}

					if (fs.existsSync(filename)) {
						fs.unlinkSync(filename);
					}

					const stream = fs.createWriteStream(filename);
					request(url, {timeout: 10000})
						.on("error", (err) => {
							stream.destroy();
							retry(err);
						})
						.on("complete", () => {
							log(`(${counter++} / ${results.length}) Downloaded ${path.basename(url)}`)
						})
						.pipe(stream)
						.on("close", () => {
							resolve();
						});
				}
				retry();
			});
		})).then(() => {
			cb();
		});
	})
})

task("copy-overrides", () => {
	return src(["./modpack/overrides/**"])
		.pipe(dest("./dest"));
});

task("copy-serverfiles", () => {
	return src(["./serverfiles/**"])
		.pipe(dest("./dest"));
});

exports.default = series(
	"cleanup"
	, "create-folders"
	, "download-forge"
	, "download-minecraft-server"
	, "download-mods"
	, "copy-overrides"
	, "copy-serverfiles"
	, "post-cleanup"
);
