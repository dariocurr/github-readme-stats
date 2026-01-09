// @ts-check

import { retryer } from "../common/retryer.js";
import { logger } from "../common/log.js";
import { excludeRepositories } from "../common/envs.js";
import { MissingParamError } from "../common/error.js";
import { request } from "../common/http.js";

/**
 * Contributions fetcher to get repos from contributionsCollection.
 *
 * @param {any} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import("axios").AxiosResponse>} Contributions fetcher response.
 */
const contributionsFetcher = (variables, token) => {
  return request(
    {
      query: `
      query userContributions($login: String!, $from: DateTime) {
        user(login: $login) {
          contributionsCollection(from: $from) {
            commitContributionsByRepository(maxRepositories: 100) {
              repository {
                name
                nameWithOwner
                languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
                  edges {
                    size
                    node {
                      color
                      name
                    }
                  }
                }
              }
            }
            pullRequestContributionsByRepository(maxRepositories: 100) {
              repository {
                name
                nameWithOwner
                languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
                  edges {
                    size
                    node {
                      color
                      name
                    }
                  }
                }
              }
            }
            issueContributionsByRepository(maxRepositories: 100) {
              repository {
                name
                nameWithOwner
                languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
                  edges {
                    size
                    node {
                      color
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
      `,
      variables,
    },
    {
      Authorization: `token ${token}`,
    },
  );
};

/**
 * @typedef {import("./types").TopLangData} TopLangData Top languages data.
 */

/**
 * Fetch top languages for a given username.
 *
 * @param {string} username GitHub username.
 * @param {string[]} exclude_repo List of repositories to exclude.
 * @param {number} size_weight Weightage to be given to size.
 * @param {number} count_weight Weightage to be given to count.
 * @returns {Promise<TopLangData>} Top languages data.
 */
const fetchTopLanguages = async (
  username,
  exclude_repo = [],
  size_weight = 1,
  count_weight = 0,
) => {
  if (!username) {
    throw new MissingParamError(["username"]);
  }

  // Fetch repos from contributionsCollection across multiple time periods
  // Query every 6 months for the last 5 years to work around maxRepositories: 100 limit
  const now = Date.now();
  const oneYear = 365 * 24 * 60 * 60 * 1000;
  const sixMonths = oneYear / 2;
  /** @type {(string | null)[]} */
  const periods = [null]; // All time first

  for (let years = 0; years < 5; years++) {
    for (let halfYear = 0; halfYear < 2; halfYear++) {
      if (years === 0 && halfYear === 0) {
        continue; // Skip current period
      }
      const date = new Date(now - years * oneYear - halfYear * sixMonths);
      periods.push(date.toISOString());
    }
  }

  const repoMap = new Map();

  // Fetch all periods in parallel for faster execution
  const fetchPromises = periods.map(async (fromDate) => {
    try {
      const variables = { login: username };
      if (fromDate) {
        variables.from = fromDate;
      }

      const res = await retryer(contributionsFetcher, variables);

      if (res.data.errors || !res.data.data?.user?.contributionsCollection) {
        return [];
      }

      const contrib = res.data.data.user.contributionsCollection;
      return [
        ...contrib.commitContributionsByRepository,
        ...contrib.pullRequestContributionsByRepository,
        ...contrib.issueContributionsByRepository,
      ];
    } catch (err) {
      /** @type {any} */
      const e = err;
      logger.log(
        `Failed to fetch contributions for period ${fromDate || "all time"}: ${e.message || e}`,
      );
      return [];
    }
  });

  // Wait for all requests to complete
  const allCollections = await Promise.all(fetchPromises);

  // Process all results
  for (const collections of allCollections) {
    for (const item of collections) {
      const repo = item.repository;
      if (!repo || !repo.languages?.edges?.length) {
        continue;
      }
      const key = repo.nameWithOwner || repo.name;
      if (key && !repoMap.has(key)) {
        repoMap.set(key, repo);
      }
    }
  }

  let repoNodes = Array.from(repoMap.values());
  /** @type {Record<string, boolean>} */
  let repoToHide = {};
  const allExcludedRepos = [...exclude_repo, ...excludeRepositories];

  // Populate repoToHide map for quick lookup
  allExcludedRepos.forEach((repoName) => {
    repoToHide[repoName] = true;
  });

  // filter out repositories to be hidden
  repoNodes = repoNodes.filter((repo) => !repoToHide[repo.name]);

  let repoCount = 0;

  repoNodes = repoNodes
    .filter((node) => node.languages.edges.length > 0)
    // flatten the list of language nodes
    .reduce((acc, curr) => curr.languages.edges.concat(acc), [])
    .reduce((acc, prev) => {
      // get the size of the language (bytes)
      let langSize = prev.size;

      // if we already have the language in the accumulator
      // & the current language name is same as previous name
      // add the size to the language size and increase repoCount.
      if (acc[prev.node.name] && prev.node.name === acc[prev.node.name].name) {
        langSize = prev.size + acc[prev.node.name].size;
        repoCount += 1;
      } else {
        // reset repoCount to 1
        // language must exist in at least one repo to be detected
        repoCount = 1;
      }
      return {
        ...acc,
        [prev.node.name]: {
          name: prev.node.name,
          color: prev.node.color,
          size: langSize,
          count: repoCount,
        },
      };
    }, {});

  Object.keys(repoNodes).forEach((name) => {
    // comparison index calculation
    repoNodes[name].size =
      Math.pow(repoNodes[name].size, size_weight) *
      Math.pow(repoNodes[name].count, count_weight);
  });

  const topLangs = Object.keys(repoNodes)
    .sort((a, b) => repoNodes[b].size - repoNodes[a].size)
    .reduce((result, key) => {
      result[key] = repoNodes[key];
      return result;
    }, {});

  return topLangs;
};

export { fetchTopLanguages };
export default fetchTopLanguages;
