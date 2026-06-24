
import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import { Octokit } from "@octokit/core";
import { createActionAuth } from "@octokit/auth-action";
import { Error, isError } from './error';

// versionPrefix is used in Github release names, and can
// optionally be specified in the action's version parameter.
const versionPrefix = "v";

export async function getFlytectl(version: string): Promise<string | Error> {
  const binaryPath = tc.find('flytectl', version, os.arch());
  if (binaryPath !== '') {
    core.info(`Found in cache @ ${binaryPath}`);
    return binaryPath;
  }

  core.info(`Resolving the download URL for the current platform...`);
  const downloadURL = await getDownloadURL(version);
  if (isError(downloadURL)) {
    return downloadURL
  }

  core.info(`Downloading flytectl version "${version}" from ${downloadURL}`);
  const downloadPath = await tc.downloadTool(downloadURL);
  core.info(`Successfully downloaded flytectl version "${version}" from ${downloadURL}`);

  core.info('Extracting flytectl...');
  const extractPath = await tc.extractTar(downloadPath);
  core.info(`Successfully extracted flytectl to ${extractPath}`);

  core.info('Adding flytectl to the cache...');
  const cacheDir = await tc.cacheDir(
    path.join(extractPath),
    'flytectl',
    version,
    os.arch()
  );
  core.info(`Successfully cached flytectl to ${cacheDir}`);

  return cacheDir;
}

// getDownloadURL resolves flytectl's Github download URL for the
// current architecture and platform.
async function getDownloadURL(version: string): Promise<string | Error> {
  let architecture = '';
  switch (os.arch()) {
    case 'x64':
      architecture = 'x86_64';
      break;
    default:
      return {
        message: `The "${os.arch()}" architecture is not supported with a flytectl release.`
      };
  }
  let platform = '';
  switch (os.platform()) {
    case 'linux':
      platform = 'Linux';
      break;
    default:
      return {
        message: `The "${os.platform()}" platform is not supported with a flytectl release.`
      };
  }

  const assetName = `flytectl_${platform}_${architecture}.tar.gz`
  const octokit = new Octokit({ authStrategy: createActionAuth });
  // flyteorg/flyte is a monorepo that publishes releases for many components
  // (flyte core, flyteidl, flytectl, ...). flytectl releases are tagged with a
  // `flytectl/` prefix. The releases endpoint is paginated and ordered most
  // recent first, so we page through it until we have collected the flytectl
  // releases we need. Without paging, a burst of non-flytectl releases can push
  // every `flytectl/` tag off the first page, leaving us with nothing to pick.
  const perPage = 100;
  const maxPages = 20;
  const filteredReleases: { tag_name: string; assets: { name: string; browser_download_url: string }[] }[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data: releases } = await octokit.request(
      'GET /repos/{owner}/{repo}/releases',
      {
        owner: 'flyteorg',
        repo: 'flyte',
        per_page: perPage,
        page,
      }
    );
    // Filter out releases for which the tags do not have the prefix `flytectl/`
    filteredReleases.push(...releases.filter((release) => release.tag_name.startsWith('flytectl/')));
    // For `latest` we only need the most recent flytectl release; stop as soon
    // as we have found one. For a specific version, keep paging until we find a
    // matching tag or run out of releases.
    if (version === 'latest' && filteredReleases.length > 0) {
      break;
    }
    if (version !== 'latest' && filteredReleases.some((release) => releaseTagIsVersion(release.tag_name, version))) {
      break;
    }
    if (releases.length < perPage) {
      // Last page reached.
      break;
    }
  }
  switch (version) {
    case 'latest':
      if (filteredReleases.length === 0) {
        return {
          message: `Unable to find any flytectl release in flyteorg/flyte.`
        };
      }
      for (const asset of filteredReleases[0].assets) {
        if (assetName === asset.name) {
          return asset.browser_download_url;
        }
      }
      break;
    default:
      for (const release of filteredReleases) {
        if (releaseTagIsVersion(release.tag_name, version)) {
          for (const asset of release.assets) {
            if (assetName === asset.name) {
              return asset.browser_download_url;
            }
          }
        }
      }
  }
  return {
    message: `Unable to find flytectl version "${version}" for platform "${platform}" and architecture "${architecture}".`
  };
}

function releaseTagIsVersion(releaseTag: string, version: string): boolean {
  // Remove the prefix `flytectl/` from releaseTag if it exists
  if (releaseTag.indexOf('flytectl/') === 0) {
    releaseTag = releaseTag.slice('flytectl/'.length)
  }

  if (releaseTag.indexOf(versionPrefix) === 0) {
    releaseTag = releaseTag.slice(versionPrefix.length)
  }
  if (version.indexOf(versionPrefix) === 0) {
    version = version.slice(versionPrefix.length)
  }
  return releaseTag === version
}

