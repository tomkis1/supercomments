var Constants = require('../constants/Constants');
var FormErrors = require('../constants/FormErrors');
var Snoocore = require('snoocore');
var jsonp = require('jsonp');
var shortid = require('shortid');
var url = require('url');

const DISQUS_API_URL = 'https://disqus.com/api/3.0/threads/';
const DISQUS_DETAILS_ENDPOINT = 'details.json';
const DISQUS_API_KEY = 'o2FOkUk8qdMbHO0IaSgOcF0IFf2FhFWRcGuDPUHtsi89ymcvMZT5p6S5PAkf3h80';

const USER_AGENT = 'SuperComments';
const AUTH_WINDOW_WIDTH = 1024;
const AUTH_WINDOW_HEIGHT = 800;
const AUTH_TIMEOUT_MS = 3600*1000;

function createAPI() {
  return new Snoocore({
    userAgent: USER_AGENT,
    oauth: { 
      type: 'implicit',
      duration: 'permanent',
      consumerKey: 'dtW9TLAGpuiLsw',
      redirectUri: 'http://127.0.0.1:3000/html/redditAuth.html',
      scope: [ 'identity', 'read', 'submit', 'vote', 'edit', 'report' ]
    }
  });
}

var reddit = createAPI();

function getDisqusThreadDetails(postUrl, forum) {
  var deferred = new Promise((resolve, reject) => {
    var parsedUrl = url.parse(`${DISQUS_API_URL}${DISQUS_DETAILS_ENDPOINT}`);
    parsedUrl.query = {
      api_key: DISQUS_API_KEY,
      forum: forum,
      thread: `link:${postUrl}`
    };
    jsonp(url.format(parsedUrl), (err, data) => {
      if (err) {
        reject(err);
      }
      else {
        resolve(data.response);
      }
    });
  });
  return deferred;
}

function getBestRedditPost(postUrl) {
  return reddit('search.json').get({ q: 'url:' + postUrl }).then((listing) => {
    var sortedPosts = listing.data.children.sort((a, b) => {
      // Descending order
      return b.data.score - a.data.score;
    });
    return sortedPosts.length > 0 ? sortedPosts[0].data : null;
  });
}

function saveSession(token, userName) {
  var superComments = localStorage.superComments ? JSON.parse(localStorage.superComments) : {};
  if (!superComments.reddit) {
    superComments.reddit = {};
  }
  superComments.reddit.token = token;
  superComments.reddit.userName = userName;
  superComments.reddit.timestamp = Date.now();
  localStorage.superComments = JSON.stringify(superComments);
}

function restoreSession() {
  if (localStorage.superComments) {
    var superComments = JSON.parse(localStorage.superComments);
    if (superComments.reddit && superComments.reddit.token) {
      if (Date.now() - superComments.reddit.timestamp < AUTH_TIMEOUT_MS) {
        reddit.auth(superComments.reddit.token);
        return superComments.reddit.userName;
      }
    }
  }
  // Null signals that no session was restored
  return null;
}

var Actions = {
  updateUrl: function(payload) {
    var postUrl = payload.url;
    var config = payload.config;
    var store = this.flux.store('RedditStore');
    if (!store.getState().userName) {
      var userName = restoreSession();
      if (userName) {
        this.dispatch(Constants.LOGGED_IN, { userName: userName, unreadCount: 0 });
      }
    }
    this.dispatch(Constants.UPDATING_URL, payload);
    Promise.all([
      getBestRedditPost(postUrl).then((post) => {
        return { reddit: post };
      }),
      getDisqusThreadDetails(postUrl, config.disqus.forum).then((details) => {
        return { disqus: details };
      })
    ]).then((values) => {
      this.dispatch(Constants.UPDATED_URL, values.reduce((all, current) => {
        return Object.assign(all, current);
      }, {}));
      this.flux.actions.reloadComments({ post: store.getState().post, sortBy: 'best' });
    });
  },

  login: function() {
    var createLoginMessageListener = function(csrf, dispatch, flux) {
      // Used so the OAuth popup can tell us when the user has authenticated
      return function messageListener(event) {
        var data = event.data;
        if (('token' in data) && ('state' in data) && (data.state === csrf)) {
          var token = data.token;
          dispatch(Constants.LOGGING_IN);
          reddit.auth(token).then(() => {
            return reddit('/api/v1/me').get();
          })
          .then((data) => {
            var userName = data.name;
            dispatch(Constants.LOGGED_IN, { userName: userName, unreadCount: data.inbox_count });
            saveSession(token, userName);

            var store = flux.store('RedditStore');
            flux.actions.reloadComments({ post: store.getState().post, sortBy: store.getState().sortBy });
          });
        }
        window.removeEventListener('message', messageListener, false);
      };
    };

    var state = shortid.generate(); // CSRF
    var authUrl = reddit.getImplicitAuthUrl(state);

    window.addEventListener('message', createLoginMessageListener(state, this.dispatch, this.flux), false);
    window.open(authUrl, 'RedditAuth', `height=${AUTH_WINDOW_HEIGHT},width=${AUTH_WINDOW_WIDTH}`);
  },

  logout: function() {
    reddit.deauth().then(() => {
      delete localStorage.superComments;
      this.dispatch(Constants.LOGOUT);
      var store = this.flux.store('RedditStore');
      this.flux.actions.reloadComments({ post: store.getState().post, sortBy: store.getState().sortBy });
    });
  },

  clearUnreadCount: function() {
    this.dispatch(Constants.UNREAD_MESSAGES_READ);
  },

  submitComment: function(payload) {
    this.flux.actions.itemChanged({ comment: payload.parent, newState: { postError: null }});

    var store = this.flux.store('RedditStore');
    if (!payload.body) {
      this.flux.actions.itemChanged({ comment: payload.parent, newState: { postError: FormErrors.COMMENT_EMPTY }});      
    }
    else if (!store.getState().post && !payload.secondChance) {
      // Post might have been added since we loaded the page, so try to get it
      return getBestRedditPost(store.getState().url).then((post) => {
        this.dispatch(Constants.UPDATED_URL, { reddit: post });
        payload.secondChance = true;
        this.flux.actions.submitComment(payload);
      });
    }
    else if (!store.getState().post) {
      this.flux.actions.itemChanged({ comment: payload.parent, newState: { postError: FormErrors.PAGE_NOT_SUBMITTED }});      
    }
    else {
      this.flux.actions.itemChanged({ comment: payload.parent, newState: { replyFormVisible: false, formExpanded: false, replyBody: '' }});

      var tempId = shortid.generate();
      this.dispatch(Constants.SUBMITTING_COMMENT, Object.assign({ id: tempId }, payload));

      var parent = payload.parent ? payload.parent : this.flux.store('RedditStore').getState().post;

      reddit('/api/comment').post({
        text: payload.body,
        thing_id: parent.get('name')
      }).then((result) => {
        if (result.json.data.things && result.json.data.things.length > 0) {
          var comment = result.json.data.things[0].data;
          this.dispatch(Constants.SUBMITTED_COMMENT, { id: tempId, comment: comment });
        }
      });
    }
  },

  vote: function(payload) {
    var thing = payload.thing;
    this.dispatch(Constants.VOTING, payload);
    reddit('/api/vote').post({
      id: thing.get('name'),
      dir: payload.dir
    }).then(() => {
      this.dispatch(Constants.VOTED, thing);
    });
  },

  reloadComments: function(payload) {
    this.dispatch(Constants.RELOADING_COMMENTS);
    if (payload.post) {
      reddit('comments/' + payload.post.get('id') + '.json').get({ sort: payload.sortBy }).then((listings) => {
        this.dispatch(Constants.RELOADED_COMMENTS, { post: listings[0].data.children[0].data, comments: listings[1] });
      });
    }
    else {
      this.dispatch(Constants.RELOADED_COMMENTS, null);
    }
  },

  sortByBest: function() {
    this.dispatch(Constants.SORT_BY_BEST);
    var store = this.flux.store('RedditStore');
    this.flux.actions.reloadComments({ post: store.getState().post, sortBy: store.getState().sortBy });
  },

  sortByNewest: function() {
    this.dispatch(Constants.SORT_BY_NEWEST);
    var store = this.flux.store('RedditStore');
    this.flux.actions.reloadComments({ post: store.getState().post, sortBy: store.getState().sortBy });
  },

  sortByOldest: function() {
    this.dispatch(Constants.SORT_BY_OLDEST);
    var store = this.flux.store('RedditStore');
    this.flux.actions.reloadComments({ post: store.getState().post, sortBy: store.getState().sortBy });
  },

  editComment: function(payload) {
    var comment = payload.comment;
    this.dispatch(Constants.EDITING_COMMENT, payload);
    reddit('/api/editusertext').post({
      thing_id: comment.get('name'),
      text: payload.body
    }).then(() => {
      this.dispatch(Constants.EDITED_COMMENT, comment);
    });
  },

  deleteComment: function(comment) {
    this.dispatch(Constants.DELETING_COMMENT, comment);
    reddit('/api/del').post({
      id: comment.get('name'),
    }).then(() => {
      this.dispatch(Constants.DELETED_COMMENT, comment);
    });
  },

  reportComment: function(comment) {
    this.dispatch(Constants.REPORTING_COMMENT, comment);
    // TODO: currently getting a 403 for this, need to investigate
    reddit('/api/report').post({
      thing_id: comment.get('name'),
      reason: 'other',
      other_reason: 'inappropriate (reported via SuperComments)'
    }).then(() => {
      this.dispatch(Constants.REPORTED_COMMENT, comment);
    });
  },

  itemChanged: function(payload) {
    this.dispatch(Constants.ITEM_CHANGED, payload);
  },

  setTooltip: function(tooltip) {
    this.dispatch(Constants.SET_TOOLTIP, tooltip);
  },

  hideTooltip: function() {
    this.dispatch(Constants.SET_TOOLTIP, null);
  },

  disqusTabChanged: function() {
    var store = this.flux.store('DisqusStore');
    getDisqusThreadDetails(store.getState().url, store.getState().forum).then((details) => {
      this.dispatch(Constants.RELOADED_DISQUS_DETAILS, details);
    });
  }
};

reddit.on('access_token_expired', Actions.logout);

module.exports = Actions;