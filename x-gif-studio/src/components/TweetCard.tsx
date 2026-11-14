import React from 'react'
import type { TweetInfo } from '../shared/types'
import { formatDateTime } from '../core/format'
import { Icon } from './ui'

function Avatar({ tweet }: { tweet: TweetInfo }) {
  const initial = (tweet.author.name || tweet.author.screenName || '?').slice(0, 1).toUpperCase()
  return (
    <span className="tweet-avatar">
      <span className="tweet-avatar-fallback">{initial}</span>
      {tweet.author.avatarUrl ? (
        <img
          src={tweet.author.avatarUrl}
          alt={`${tweet.author.name} 的头像`}
          loading="lazy"
          onError={(event) => {
            event.currentTarget.style.display = 'none'
          }}
        />
      ) : null}
    </span>
  )
}

/** 推文信息卡片：作者、正文、时间与原链接 */
export function TweetCard({ tweet }: { tweet: TweetInfo }) {
  return (
    <article className="tweet-card" data-testid="tweet-card">
      <div className="tweet-card-head">
        <Avatar tweet={tweet} />
        <div className="tweet-author">
          <div className="tweet-author-line">
            <span className="tweet-author-name">{tweet.author.name}</span>
            {tweet.author.verified ? (
              <span className="tweet-verified" title="已验证账号">
                <Icon name="check" size={10} strokeWidth={2.6} />
              </span>
            ) : null}
            <span className="tweet-author-handle">@{tweet.author.screenName}</span>
          </div>
          <div className="tweet-meta-line">
            <span>{formatDateTime(tweet.createdAt)}</span>
            <span className="tweet-meta-dot" />
            <span>共 {tweet.media.length} 个媒体</span>
          </div>
        </div>
        <a className="tweet-link" href={tweet.url} target="_blank" rel="noreferrer" title={tweet.url}>
          <Icon name="external" size={13} />
          打开原推文
        </a>
      </div>
      {tweet.text ? <p className="tweet-text">{tweet.text}</p> : <p className="tweet-text is-empty">（该推文没有正文）</p>}
    </article>
  )
}