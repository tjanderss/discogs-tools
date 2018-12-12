// TODO: refactor Discogs API operations into some kind of DiscogsClient -module?
const Promise = require('bluebird')
const rp = require('request-promise');
const fs = require('fs');
const path = require('path')
const Bottleneck = require('bottleneck');
const Mustache = require('mustache');
const flatCache = require('flat-cache');
const ncp = Promise.promisify(require('ncp').ncp);
const log = console.log;

process.env["NODE_CONFIG_DIR"] = "../config/";
const config = require('config');

const CACHE_PATH = '../.cache';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_LIMITER_TIME = 1000;

const defaultRequestOpts = {
	headers: {
		'User-Agent': 'TomsInitialCollectionsTest/0.1 +http://starting.out.com',
		'Authorization': `Discogs token=${config.get('authToken')}`
	},
	json: true,
	resolveWithFullResponse: true
} 
 
const limiter = new Bottleneck({
  minTime: config.get('limiterTime') || DEFAULT_LIMITER_TIME
});

const cache = flatCache.load('releasesCache', path.resolve(CACHE_PATH));

const debug = (msg) => {
	if (config.get('debug')) {
		log(`DEBUG: ${msg}`);
	}
}

const request = async(requestOpts) => {
	requestOpts = Object.assign(defaultRequestOpts, requestOpts);
	log(`>> ${requestOpts.method || 'GET'} ${requestOpts.uri}`)
	const response = await limiter.schedule(() => rp(requestOpts));
	data = response.body;
	return response.body;
}

const getIdentity = async() => {
	log(`Fetching user identity`);
	const identity = await request({
		uri: `${config.get('baseUri')}/oauth/identity`
	});
	log(`User identified as '${identity.username}'`);
	return identity;
}

const getCollectionFolders = async(username) => {
	log(`Fetching folders for user ${username}`);
	const data = await request({
		uri: `${config.get('baseUri')}/users/${username}/collection/folders`
	});
	log(`Found ${data.folders.length} folders`);
	return data.folders;
}

const getFolderReleases = async(username, folderId) => {
	log(`Fetching releases in folder ${folderId}`);
	const requestOpts = {
		uri: `${config.get('baseUri')}/users/${username}/collection/folders/${folderId}/releases`,
		qs: {
			per_page: config.get('pageSize') || DEFAULT_PAGE_SIZE
		}
	}
	let releases = [];
	let pageNumber = 1;
	while (true) {
		log(`--> Fetching page ${pageNumber}`)
		const data = await request(requestOpts);
		releases = releases.concat(data.releases);
		const pagination = data.pagination;
		pageNumber = pagination.page;
		if (pageNumber == pagination.pages) {
			break;
		}
		// get next page of releases
		requestOpts.uri = pagination.urls.next;
	}
	log(`Found a total of ${releases.length} releases`);
	return releases;
}

const getReleaseDetails = async(release) => {
	log(`Fetching details for release '${release.basic_information.title}' (id ${release.id})`);
	const data = await request({
		uri: `${config.get('baseUri')}/releases/${release.id}?EUR`
	});
	return data;
}

const getPriceSuggestionFor = async(release) => {
	log(`Fetching price suggestions for '${release.basic_information.title}' (id ${release.id})`);
	const data = await request({
		uri: `${config.get('baseUri')}/marketplace/price_suggestions/${release.id}`
	});
	return data;
}

const retrieveThumbnailFor = async(release) => {
	const thumbnailPath = `${CACHE_PATH}/images/${release.id}.jpg`
	if (fs.existsSync(thumbnailPath)) {
		debug(`Release thumbnail found in image cache: ${thumbnailPath}`);
		return;
	}
	log(`Fetching thumbnail for release '${release.basic_information.title}' (id ${release.id})`);
	const data = await request({
		uri: release.basic_information.thumb,
		encoding: null
	});
	log (`Writing thumbnail to image cache: ${thumbnailPath}`);
	fs.writeFileSync(`${thumbnailPath}`, data);
}

const main = async () => {
	debug(`Configuration: ${JSON.stringify(config, null, 2)}`);
	
	const identity = await getIdentity();
	const username = identity.username;
	const folders = await getCollectionFolders(username);
	const folder = folders.find(folder => {
		return folder.name === config.get('folderName');
	});

	const releases = await getFolderReleases(username, folder.id);
	const results = [];

	let totalAveragePrice = 0.0;
	let totalLowestPrices = 0.0;

	for (const release of releases.slice(0,20)) {
		let result = cache.getKey(release.id);
		if (result) {
			log(`Release '${release.basic_information.title}' (id ${release.id}) found in cache.`);
		} else {
			const releaseDetails = await getReleaseDetails(release);
			const priceSuggestion = await getPriceSuggestionFor(release);
			const averagePrice = calculateAveragePriceFrom(Object.entries(priceSuggestion));

			await retrieveThumbnailFor(release);
			result = {
				id: releaseDetails.id,
				artist: releaseDetails.artists_sort,
				title: releaseDetails.title,
				label: releaseDetails.labels[0].name,
				catno: releaseDetails.labels[0].catno,
				released: releaseDetails.released,
				genres: releaseDetails.genres.join('/'),
				rating: releaseDetails.rating,
				uri: releaseDetails.uri,
				averagePriceSuggestion: averagePrice,
				lowestPrice: releaseDetails.lowest_price
			};

			log(`Saving result item with cache key ${release.id}`);
			cache.setKey(release.id, result);
		}

		totalAveragePrice += result.averagePriceSuggestion;
		totalLowestPrices += result.lowestPrice;
		
		results.push(result);
	}
	cache.save();

	debug(JSON.stringify(results, null, 2));

	log(`Copying cached thumbnail images to /dist/images `)
	await ncp(`${CACHE_PATH}/images`, '../dist/images', { dereference: false })

	log(`Total avg price for folder: ${totalAveragePrice} €`);
	log(`Total lowest for folder: ${totalLowestPrices} €`);

	const template = 
	`<html><head><link href="styles.css" rel="stylesheet" type="text/css" media="all"></head></html>
	<table>
	{{#results}}
	<tr>
	<td><img src="images/{{id}}.jpg"/></td>
	<td>{{artist}} - {{title}}<br/><p>{{label}} ({{catno}}), Released {{released}}, {{genres}} [ <a target="_blank" href="{{uri}}">discogs</a> ]</p></td>
	{{/results}}
	</table>`

	const mustacheOutput = Mustache.render(template, { results });
	fs.writeFileSync(path.resolve('../dist/catalog.html'), mustacheOutput);
};

function calculateAveragePriceFrom(priceSuggestions) {
	let averagePrice = 0.0;
	priceSuggestions.forEach(([condition, value]) => { 
		if (config.get('includeConditions').includes(condition)) { 
			averagePrice += value.value 
		}
	});
	averagePrice = averagePrice / priceSuggestions.length;
	return Math.round(averagePrice * 100) / 100;
}

main().catch(err => console.error(err));
