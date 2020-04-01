const fs       = require("fs");
const del      = require("del");
const zip      = require("gulp-zip");
const log      = require("fancy-log");
const path     = require("path");
const unzip    = require("unzipper");
const Promise  = require("bluebird");
const mustache = require("mustache");
const through  = require("through2");

const { src, task, series, dest } = require("gulp");
const { ConcurrentRetryDownloader, retryRequest } = require("./util/downloaders.js");

const MODPACK_MANIFEST = JSON.parse(fs.readFileSync("./modpack/manifest.json"));

const ZIP_DEST_FOLDER    = "build";
const DEST_FOLDER        = "build";
const SERVER_DEST_FOLDER = path.join(DEST_FOLDER, "server");
const TEMP_FOLDER        = path.join(DEST_FOLDER, "temp");

/**
 * Config!
 * 
 * Uses ./config.default.js for default values.
 * 
 * Please create ./config.js and overwrite values as you see fit.
 * Don't modify the default file!
 */
const CONFIG = require("./config.default.js");
if (!CONFIG || CONFIG.constructor !== Object) {
	throw new Error(`Fatal Error: malformed default config file.`);
}

const CUSTOM_CONFIG_PATH = "./config.js";

/**
 * If ./config.js exists, merge its values with the default config file.
 */
if (fs.existsSync(CUSTOM_CONFIG_PATH)) {
	const customConfig = require(CUSTOM_CONFIG_PATH);
	if (!customConfig || customConfig.constructor !== Object) {
		throw new Error(`Fatal Error: malformed ${CUSTOM_CONFIG_PATH}.`);
	}

	Object.assign(defaultConfig, customConfig);
}

const localStorage = {};

const LIBRARY_REG = /^(.+?):(.+?):(.+?)$/;

/**
 * Parses the library name into path following the standard package naming convention.
 * 
 * Turns `package:name:version` into `package/name/version/name-version`.
 * 
 * @param {string} library 
 */
const libraryToPath = (library) => {
	const parsedLibrary = LIBRARY_REG.exec(library);
	if (parsedLibrary) {
		const package = parsedLibrary[1].replace(/\./g, "/");
		const name = parsedLibrary[2];
		const version = parsedLibrary[3];

		const newURL = `${package}/${name}/${version}/${name}-${version}`

		return newURL;
	}
}

/**
 * Clean-up. Recursively removes `./dest/**`
 */
task("cleanup", (cb) => {
	del.sync(DEST_FOLDER);
	cb();
});

/**
 * Creates `dest` and `temp` folders.
 */
task("create-folders", (cb) => {
	const toCreate = [
		SERVER_DEST_FOLDER,
		TEMP_FOLDER
	];

	toCreate.forEach((dir) => {
		log(`Creating folder ${path.normalize(dir)}`);
		fs.mkdirSync(path.resolve(dir), { recursive: true })
	});

	cb();
});

/**
 * Initialize the file downloader.
 */
const DOWNLOADER = new ConcurrentRetryDownloader({
	concurrency  : CONFIG.downloaderConcurrency
	, checkHashes: CONFIG.downloaderCheckHashes
	, maxRetries : CONFIG.downloaderMaxRetries
})
.on("start", (args) => {
	log(`Downloading ${path.basename(args.fileDef.path)}...`)
})
.on("complete", (args) => {
	const numFiles = args.total > 1 ? `(${args.index + 1} / ${args.total}) ` : "";

	/**
	 * Create a directory for the file.
	 */
	const dirname = path.dirname(args.fileDef.path);
	if (!fs.existsSync(dirname)) {
		fs.mkdirSync(dirname, { recursive: true })
	}

	/**
	 * If file exists already, remove it.
	 * A failed attempt might leave an malformed file.
	 */
	if (fs.existsSync(args.fileDef.path)) {
		fs.unlinkSync(args.fileDef.path);
	}

	const fd = fs.openSync(args.fileDef.path, "wx");
	fs.writeSync(fd, args.output);
	fs.closeSync(fd);
	log(numFiles + `Downloaded and saved ${path.basename(args.fileDef.path)}`)
})
.on("retry", (args) => {
	log(`Failed to download ${path.basename(args.fileDef.path)}, retrying...`)
});

/**
 * Wraps the `.download()` method of DOWNLOADER.
 * 
 * @param {FileDef[]} files Array of libraries to download.
 * @param {(error?) => void} callback Optional callback to call once everything is downloaded.
 */
const downloadAndSaveFiles = (files, callback = null) => {
	DOWNLOADER.download(files)
		.then(() => {
			if (callback) {
				callback();
			}
		})
		.catch((args) => {
			if (callback) {
				log();
				if (args.fileDef && args.fileDef.path && args.error) {
					log(`Failed to download ${path.basename(args.fileDef.path)}`)
					callback(args.error);
				} else {
					callback(args);
				}
			}
		});
}

const MOJANG_MAVEN = "https://libraries.minecraft.net/";

/**
 * Library wrapper for downloadFiles.
 * 
 * @param {string[]} libraries Array of libraries to download.
 * @param {(error?) => void} callback Optional callback to call once everything is downloaded.
 */
const downloadLibraries = (libraries, callback = null) => {
	downloadAndSaveFiles(
		libraries.map((library) => {
			const libraryPath = libraryToPath(library.name) + ".jar";
			const localLibraryPath = path.join(SERVER_DEST_FOLDER, "libraries", libraryPath);
			const url = library.url || MOJANG_MAVEN;

			const def = {
				url: url + libraryPath,
				path: localLibraryPath,
			}

			if (library.checksums) {
				def.hashes = [
					{ id: "sha1", hashes: library.checksums }
				]
			}

			return def;
		}), callback
	);
}

const FORGE_VERSION_REG = /forge-(.+)/;
const FORGE_MAVEN = "https://files.minecraftforge.net/maven/";

/**
 * Download the Forge jar.
 * 
 * Extract, parse the profile data and download required libraries.
 */
task("download-forge", (cb) => {
	const minecraft = MODPACK_MANIFEST.minecraft;

	/**
	 * Break down the Forge version defined in manifest.json.
	 */
	const parsedForgeEntry = FORGE_VERSION_REG.exec(
		(minecraft.modLoaders
			.find(x => x.id && x.id.indexOf("forge") != -1
		) || {}).id || ""
	);

	if (parsedForgeEntry) {
		/**
		 * Transform Forge version into Maven library path.
		 */
		const forgeMavenLibrary = `net.minecraftforge:forge:${minecraft.version}-${parsedForgeEntry[1]}`;
		const forgeInstallerPath = libraryToPath(forgeMavenLibrary) + "-installer.jar";
		const localForgePath = path.join(TEMP_FOLDER, path.basename(forgeInstallerPath));

		/**
		 * Fetch the Forge installer
		 */
		downloadAndSaveFiles([{
			url: FORGE_MAVEN + forgeInstallerPath
			, path: localForgePath
		}], () => {
			log("Extracting the Forge installer...")

			/**
			 * Extract the installer into temp folder.
			 */
			fs.createReadStream(localForgePath)
				.pipe(unzip.Extract({ path: path.join(TEMP_FOLDER, "forge") }))
				.on("close", () => {
					log("Reading the manifest file...")

					/**
					 * Parse the profile manifest.
					 */
					const manifest = JSON.parse(
						fs.readFileSync(path.join(TEMP_FOLDER, "forge", "install_profile.json"))
					);

					if (manifest && manifest.versionInfo && manifest.versionInfo.libraries) {
						const forgeUniversalPath = path.basename(
							libraryToPath(forgeMavenLibrary) + "-universal.jar"
						);

						/**
						 * Move the universal jar into the dist folder.
						 */
						log("Moving the Forge file...")
						fs.renameSync(
							path.join(TEMP_FOLDER, "forge", forgeUniversalPath)
							, path.join(SERVER_DEST_FOLDER, forgeUniversalPath)
						);

						/**
						 * Save the universal jar file name for later.
						 * 
						 * We will need it to process launchscripts.
						 */
						localStorage.forgeJar = forgeUniversalPath;

						log("Fetching server libraries...")

						/**
						 * Finally, fetch libraries.
						 */
						downloadLibraries(
							manifest
								.versionInfo
								.libraries
								.filter(x => x.serverreq)
							, cb
						);
					} else {
						cb("Malformed Forge manifest file.")
					}
				});
		});
	} else {
		cb("Malformed Forge version in manifest.json.")
	}
});

/**
 * Post-cleanups.
 */
task("post-cleanup", (cb) => {
	del.sync(TEMP_FOLDER);
	cb();
})

const LAUNCHERMETA_VERSION_MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest.json";

/**
 * Download the server jar.
 */
task("download-minecraft-server", (cb) => {
	log("Fetching the Minecraft version manifest...")

	/**
	 * Fetch the manifest file of all Minecraft versions.
	 */
	retryRequest(
		CONFIG.downloaderMaxRetries
		, { uri: LAUNCHERMETA_VERSION_MANIFEST, json: true }
	).then((manifest) => {
		/**
		 * Find the version defined in manifest.json.
		 */
		const version = manifest.versions.find(x => x.id == MODPACK_MANIFEST.minecraft.version);
		if (version) {
			log(`Fetching the manifest file for Minecraft ${version.id}...`)

			/**
			 * Fetch the version manifest file.
			 */
			retryRequest(
				CONFIG.downloaderMaxRetries
				, { uri: version.url, json: true }
			).then((versionManifest) => {			
				if (versionManifest.downloads && versionManifest.downloads.server) {
					/**
					 * Fetch the server jar file.
					 * 
					 * Pass SHA1 hash to compare against the downloaded file.
					 */
					downloadAndSaveFiles([{
						url: versionManifest.downloads.server.url
						, path: path.join(SERVER_DEST_FOLDER, `minecraft_server.${version.id}.jar`)
						, hashes: [
							{ id: "sha1", hashes: versionManifest.downloads.server.sha1 }
						]
					}], cb);
				} else {
					cb(`No server jar file found for ${version.id}`);
				}
			}).catch(cb);
		} else {
			cb(`Couldn't find ${MODPACK_MANIFEST.minecraft.version} in the version manifest.`);
		}
	});
});

/**
 * Downloads mods according to manifest.json and checks hashes.
 */
task("download-mods", (cb) => {
	log("Fetching mods...");
	
	/**
	 * Fetch file descriptions for download urls and hashes
	 * by mapping files to Promises.
	 */
	Promise.map(MODPACK_MANIFEST.files, file => {
		return retryRequest(
			CONFIG.downloaderMaxRetries
			, {
				uri: `https://addons-ecs.forgesvc.net/api/v2/addon/${file.projectID}/file/${file.fileID}`
				, json: true
			}
		)
	}, { concurrency: CONFIG.downloaderConcurrency }).then(fileInfos => {
		log(`Fetched ${fileInfos.length} mods...`);

		/**
		 * Download and save mod files.
		 * 
		 * Pass mod fingerprints to compare against downloaded files.
		 */
		downloadAndSaveFiles(
			fileInfos.map(fileInfo => {
				return {
					url: fileInfo.downloadUrl
					, path: path.join(SERVER_DEST_FOLDER, "mods", path.basename(fileInfo.downloadUrl))
					, hashes: [
						{ id: "murmurhash", hashes: modInfo.packageFingerprint }
					]
				}
			}), cb
		);
	})
})

/**
 * Copies modpack overrides.
 */
task("copy-overrides", () => {
	return src(["./modpack/overrides/**", ...CONFIG.copyOverridesNegativeGlobs])
		.pipe(dest(SERVER_DEST_FOLDER));
});

/**
 * Copies files from ./serverfiles into dest folder.
 */
task("copy-serverfiles", () => {
	return src(["./serverfiles/**"])
		.pipe(dest(SERVER_DEST_FOLDER));
});

/**
 * Copies files from ./launchscripts into dest folder and processes them using mustache.
 * 
 * Replaces jvmArgs, minRAM, maxRAM and forgeJar.
 */
task("launchscripts", () => {
	const rules = {
		jvmArgs: CONFIG.launchscriptsJVMArgs
		, minRAM: CONFIG.launchscriptsMinRAM
		, maxRAM: CONFIG.launchscriptsMaxRAM
	};

	if (localStorage.forgeJar) {
		rules.forgeJar = localStorage.forgeJar;
	} else {
		rules.forgeJar = "";
		log.warn("No forgeJar specified!");
		log.warn("Did the download-forge task fail?")
	}

	return src(['./launchscripts/**'])
		.pipe(
			through.obj((file, _, callback) => {
				if (file.isBuffer()) {
					const rendered = mustache.render(file.contents.toString(), rules);
					file.contents = Buffer.from(rendered);
				}
				callback(null, file);
			})
		)
		.pipe(dest(SERVER_DEST_FOLDER));
})

/**
 * Zips the dest folder.
 */
task("zip", () => {
	return src(path.join(SERVER_DEST_FOLDER, "**"), { nodir: true, base: SERVER_DEST_FOLDER })
		.pipe(zip("server.zip"))
		.pipe(dest(ZIP_DEST_FOLDER));
})

exports.default = series(
	"cleanup"
	, "create-folders"
	, "download-forge"
	, "download-minecraft-server"
	, "download-mods"
	, "copy-overrides"
	, "copy-serverfiles"
	, "launchscripts"
	, "post-cleanup"
	, "zip"
);
