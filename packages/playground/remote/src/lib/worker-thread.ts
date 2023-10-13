import { WebPHP, WebPHPEndpoint, exposeAPI } from '@php-wasm/web';
import { EmscriptenDownloadMonitor } from '@php-wasm/progress';
import { removeURLScope, setURLScope } from '@php-wasm/scopes';
import { joinPaths } from '@php-wasm/util';
import { DOCROOT, wordPressSiteUrl } from './config';
import {
	getWordPressModule,
	LatestSupportedWordPressVersion,
	SupportedWordPressVersion,
	SupportedWordPressVersionsList,
} from './get-wordpress-module';
import {
	SupportedPHPExtension,
	SupportedPHPVersion,
	SupportedPHPVersionsList,
} from '@php-wasm/universal';
import { applyWebWordPressPatches } from './web-wordpress-patches';
import {
	SyncProgressCallback,
	bindOpfs,
	playgroundAvailableInOpfs,
} from './opfs/bind-opfs';
import { applyWordPressPatches } from '@wp-playground/blueprints';

// post message to parent
self.postMessage('worker-script-started');

type StartupOptions = {
	wpVersion?: string;
	phpVersion?: string;
	storage?: string;
	phpExtension?: string[];
};
const startupOptions: StartupOptions = {};
if (typeof self?.location?.href !== 'undefined') {
	const params = new URL(self.location.href).searchParams;
	startupOptions.wpVersion = params.get('wpVersion') || undefined;
	startupOptions.phpVersion = params.get('phpVersion') || undefined;
	startupOptions.storage = params.get('storage') || undefined;
	startupOptions.phpExtension = params.getAll('php-extension');
}

// Expect underscore, not a dot. Vite doesn't deal well with the dot in the
// parameters names passed to the worker via a query string.
const requestedWPVersion = (startupOptions.wpVersion || '').replace('_', '.');
const wpVersion: SupportedWordPressVersion =
	SupportedWordPressVersionsList.includes(requestedWPVersion)
		? (requestedWPVersion as SupportedWordPressVersion)
		: LatestSupportedWordPressVersion;

const requestedPhpVersion = (startupOptions.phpVersion || '').replace('_', '.');
const phpVersion: SupportedPHPVersion = SupportedPHPVersionsList.includes(
	requestedPhpVersion
)
	? (requestedPhpVersion as SupportedPHPVersion)
	: '8.0';

const phpExtensions = (startupOptions.phpExtension ||
	[]) as SupportedPHPExtension[];

let virtualOpfsRoot: FileSystemDirectoryHandle | undefined;
let virtualOpfsDir: FileSystemDirectoryHandle | undefined;
let lastOpfsDir: FileSystemDirectoryHandle | undefined;
let wordPressAvailableInOPFS = false;
if (
	(startupOptions.storage === 'opfs-browser' ||
		startupOptions.storage === 'browser') &&
	// @ts-ignore
	typeof navigator?.storage?.getDirectory !== 'undefined'
) {
	virtualOpfsRoot = await navigator.storage.getDirectory();
	virtualOpfsDir = await virtualOpfsRoot.getDirectoryHandle('wordpress', {
		create: true,
	});
	lastOpfsDir = virtualOpfsDir;
	wordPressAvailableInOPFS = await playgroundAvailableInOpfs(virtualOpfsDir!);
}

const scope = Math.random().toFixed(16);
const scopedSiteUrl = setURLScope(wordPressSiteUrl, scope).toString();
const monitor = new EmscriptenDownloadMonitor();
const wordPressModule = getWordPressModule(wpVersion);
const { php, phpReady } = WebPHP.loadSync(phpVersion, {
	downloadMonitor: monitor,
	requestHandler: {
		documentRoot: DOCROOT,
		absoluteUrl: scopedSiteUrl,
	},
	// We don't yet support loading specific PHP extensions one-by-one.
	// Let's just indicate whether we want to load all of them.
	loadAllExtensions: phpExtensions?.length > 0,
	dataModules: wordPressAvailableInOPFS ? [] : [wordPressModule],
});

/** @inheritDoc PHPClient */
export class PlaygroundWorkerEndpoint extends WebPHPEndpoint {
	/**
	 * A string representing the scope of the Playground instance.
	 */
	scope: string;

	/**
	 * A string representing the version of WordPress being used.
	 */
	wordPressVersion: string;

	/**
	 * A string representing the version of PHP being used.
	 */
	phpVersion: string;

	constructor(
		php: WebPHP,
		monitor: EmscriptenDownloadMonitor,
		scope: string,
		wordPressVersion: string,
		phpVersion: string
	) {
		super(php, monitor);
		this.scope = scope;
		this.wordPressVersion = wordPressVersion;
		this.phpVersion = phpVersion;
	}

	/**
	 * @returns WordPress module details, including the static assets directory and default theme.
	 */
	async getWordPressModuleDetails() {
		return {
			majorVersion: this.wordPressVersion,
			staticAssetsDirectory: `wp-${this.wordPressVersion.replace(
				'_',
				'.'
			)}`,
			defaultTheme: (await wordPressModule)?.defaultThemeName,
		};
	}

	async requestedPathIsAStaticFile(requestPath: string) {
		const unscopedPath = removeURLScope(
			new URL(requestPath, this.absoluteUrl)
		).pathname;
		const fsPath = joinPaths(this.documentRoot, unscopedPath);
		return this.fileExists(fsPath);
	}

	async resetVirtualOpfs() {
		if (!virtualOpfsRoot) {
			throw new Error('No virtual OPFS available.');
		}
		await virtualOpfsRoot.removeEntry(virtualOpfsDir!.name, {
			recursive: true,
		});
	}

	async reloadFilesFromOpfs() {
		await this.bindOpfs(lastOpfsDir!);
	}

	async bindOpfs(
		opfs: FileSystemDirectoryHandle,
		onProgress?: SyncProgressCallback
	) {
		lastOpfsDir = opfs;
		await bindOpfs({
			php,
			opfs,
			onProgress,
		});
	}
}

const [setApiReady, setAPIError] = exposeAPI(
	new PlaygroundWorkerEndpoint(php, monitor, scope, wpVersion, phpVersion)
);

try {
	await phpReady;

	if (!wordPressAvailableInOPFS) {
		/**
		 * Patch WordPress when it's not restored from OPFS.
		 * The stopred version, presumably, has all patches
		 * already applied.
		 */
		await wordPressModule;
		applyWebWordPressPatches(php);
		await applyWordPressPatches(php, {
			wordpressPath: DOCROOT,
			patchSecrets: true,
			disableWpNewBlogNotification: true,
			addPhpInfo: true,
			disableSiteHealth: true,
			makeEditorFrameControlled: true,
		});
	}

	if (virtualOpfsDir) {
		await bindOpfs({
			php,
			opfs: virtualOpfsDir!,
			wordPressAvailableInOPFS,
		});
	}

	// Always setup the current site URL.
	await applyWordPressPatches(php, {
		wordpressPath: DOCROOT,
		siteUrl: scopedSiteUrl,
	});

	setApiReady();
} catch (e) {
	setAPIError(e as Error);
	throw e;
}
