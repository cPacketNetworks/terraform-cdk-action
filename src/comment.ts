/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import crypto from "crypto";
import * as core from "@actions/core";
import { getOctokit } from "@actions/github";
import { Context } from "@actions/github/lib/context";
import { Inputs } from "./models";

export interface CommentControllerConfig {
  inputs: Inputs;
  context: Context;
  octokit: ReturnType<typeof getOctokit>;
}
export class CommentController {
  constructor(private config: CommentControllerConfig) {}
  async postComment(message: string): Promise<void> {
    const { inputs } = this.config;
    if (inputs.commentMode === "none") {
      core.debug(`Not commenting on PR by configuration`);
      return;
    } else if (inputs.commentMode === "pr") {
      return this.postCommentOnPr(message);
    } else if (inputs.commentMode === "commit") {
      return this.postCommentOnCommit(message);
    } else {
      core.setFailed(`Unrecognized comment mode ${inputs.commentMode}`);
      return;
    }
  }

  private async postCommentOnPr(message: string): Promise<void> {
    const { inputs, octokit, context } = this.config;

    const pull_number = await this.getPullNumber();
    if (!pull_number) {
      core.debug(`Not commenting on PR since it could not be identified`);
      return;
    }

    const tag = this.getCommentTag();
    const messageWithTag = `${tag}\n${message}`;
    let previousComment;
    if (inputs.updateComment) {
      previousComment = await this.fetchPreviousPrComment(
        octokit,
        context.repo,
        pull_number,
        tag
      );
    }

    if (previousComment) {
      core.debug(`Updating previous comment`);
      await octokit.rest.issues.updateComment({
        ...context.repo,
        body: messageWithTag,
        comment_id: previousComment.id,
      });
      return;
    }

    core.debug(`Adding new comment`);
    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: pull_number,
      body: messageWithTag,
    });
  }

  private async postCommentOnCommit(message: string): Promise<void> {
    const { inputs, octokit, context } = this.config;

    const commit_sha = context.sha;
    if (!commit_sha) {
      core.debug(`Not commenting on commit because it has been removed`);
      return;
    }

    const tag = this.getCommentTag();
    const messageWithTag = `${tag}\n${message}`;
    let previousComment;
    if (inputs.updateComment) {
      previousComment = await this.fetchPreviousCommitComment(
        octokit,
        context.repo,
        commit_sha,
        tag
      );
    }

    if (previousComment) {
      core.debug(`Updating previous comment`);
      await octokit.rest.repos.updateCommitComment({
        ...context.repo,
        body: messageWithTag,
        comment_id: previousComment.id,
      });
      return;
    }

    core.debug(`Adding new comment`);
    await octokit.rest.repos.createCommitComment({
      ...context.repo,
      commit_sha: commit_sha,
      body: messageWithTag,
    });
  }

  private async getPullNumber(): Promise<number | undefined> {
    const { octokit, context } = this.config;

    if (context.payload.pull_request?.number) {
      return context.payload.pull_request?.number;
    }

    core.debug(
      `Not running on a PR, looking for a pull request number via search`
    );

    if (!context.payload.repository?.full_name) {
      core.debug(`Could not identify repository name, skipping comment on PR`);
      return;
    }

    const q = `is:pr repo:${context.payload.repository?.full_name} sha:${context.sha}`;
    const result = await octokit.rest.search.issuesAndPullRequests({
      q,
    });

    core.debug(
      `Searched for '${q}', got ${JSON.stringify(result.data, null, 2)}`
    );

    if (result.data.items.length) {
      return result.data.items[0].number;
    }
    return;
  }

  private getCommentTag() {
    const {
      cdktfVersion,
      mode,
      stackName,
      terraformVersion,
      workingDirectory,
    } = this.config.inputs;

    const options = {
      cdktfVersion,
      terraformVersion,
      workingDirectory,
      stackName,
      mode,
    };
    const optionsHash = hashString(JSON.stringify(options));
    return `<!-- terraform cdk action for options with hash ${optionsHash} -->`;
  }

  private async fetchPreviousPrComment(
    octokit: ReturnType<typeof getOctokit>,
    repo: { owner: string; repo: string },
    pull_number: number,
    tag: string
  ) {
    const commentList = await octokit.paginate(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        ...repo,
        issue_number: pull_number,
      }
    );

    const previousComment = commentList.find((comment) =>
      comment.body?.includes(tag)
    );

    return !previousComment ? null : previousComment;
  }

  private async fetchPreviousCommitComment(
    octokit: ReturnType<typeof getOctokit>,
    repo: { owner: string; repo: string },
    commit_sha: string,
    tag: string
  ) {
    const iterator = octokit.paginate.iterator(
      octokit.rest.repos.listCommentsForCommit,
      {
        ...repo,
        commit_sha,
      }
    );

    let previousComment = undefined;

    for await (const { data: comments } of iterator) {
      for (const comment of comments) {
        if (comment.body?.includes(tag)) {
          previousComment = comment;
          break;
        }
      }
      if (previousComment) {
        break;
      }
    }
    return previousComment;
  }
}
const hashString = (str: string) => {
  return crypto.createHash("md5").update(str).digest("hex");
};
