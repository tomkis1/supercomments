import React, { PropTypes } from 'react';
import { connect } from 'react-redux';

import buildActionCreators from 'helpers/buildActionCreators';
import * as Actions from 'constants/actions';
import { getComment, mapReplies } from 'selectors/entityRepositorySelectors';

import ThreadWrapper from 'components/ThreadWrapper';
import Comment from 'components/Comment';

const NonConnectedThread = ({ author, comments, isRootThread, onClickReply }) => (
  <ThreadWrapper isRootThread={isRootThread}>
    {comments.map(comment => (
      <Comment
        onClickReply={() => onClickReply(comment.id)}
        key={comment.id}
        parentAuthor={author}
        {...comment}
      />
    ))}
  </ThreadWrapper>
);

NonConnectedThread.propTypes = {
  author: PropTypes.string,
  comments: PropTypes.array.isRequired,
  isRootThread: PropTypes.bool.isRequired,
  onClickReply: PropTypes.func.isRequired
};

const mapStateToProps = (appState, { threadId }) => ({
  author: getComment(appState, threadId).author,
  comments: mapReplies(appState, threadId)
});

const Thread = connect(
  mapStateToProps,
  buildActionCreators({
    onClickReply: Actions.Reply
  })
)(NonConnectedThread);

Thread.propTypes = {
  threadId: PropTypes.string.isRequired,
  isRootThread: PropTypes.bool.isRequired
};

export default Thread;
