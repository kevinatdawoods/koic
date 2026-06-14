#!/usr/bin/perl
use strict;
use warnings;
use Time::HiRes qw(time);
# use local::lib;
use Mojolicious::Lite;
use Mojo::IOLoop;
use Mojo::UserAgent;
use Mojo::URL;
use IO::Socket::INET;
use Scalar::Util 'refaddr';
use MIME::Base64 qw(encode_base64 decode_base64);
use Encode qw(encode FB_DEFAULT);
use IO::Handle;

# KOIC: Kevin's Own ISCABBS Client - Desktop v3.7.6 - re-add browser keep-alive
my $Code_version = '3.7.6';

$| = 1;
$SIG{PIPE} = 'IGNORE';
open(STDOUT, '>', 'koic-d.log') or die "STDOUT: $!";
open(STDERR, '>', 'koic-d.log') or die "STDERR: $!";

use constant {
    IAC => 255, DONT => 254, DO => 253, WONT => 252, WILL => 251, SB => 250, SE => 240,
    NOP => 241,  # Telnet NOP (keepalive)
    ISCA_BLOCK   => 0xA1,
    ISCA_G_STR   => 0xA2,
    ISCA_G_NAME  => 0xA3,
    ISCA_G_FIVE  => 0xA4,
    MORE_PROMPT  => 0xAB,  # --MORE-- prompt from DOC protocol
    ISCA_START   => 0xAC,
    ISCA_CONFIG  => 0xAE,
    ISCA_START3  => 0xAF,
    ISCA_CLIENT2 => 0xB0,
    ISCA_CLIENT  => 0xA0,  # Keepalive ping from BBS — must echo back IAC CLIENT
    POST_S => 0xA9,   # Start of post transfer
    POST_E => 0xAA,   # End of post transfer
    XMSG_S => 0xA7,   # Start of Xpress message transfer
    XMSG_E => 0xA8,   # End of Xpress message transfer
    NAWS => 31, NEW_ENVIRON => 39,
    CTRL_D => 0x04,
};

my %cfg = ( bbs_host => 'bbs.iscabbs.com', bbs_port => 23, inactivity => 7200 );
my %sessions = ();
my $fh;
my $trace_fh;

# ── TinyURL same-origin proxy ─────────────────────────────────────────────────

my $short_ua = Mojo::UserAgent->new;
$short_ua->connect_timeout(3);
$short_ua->inactivity_timeout(6);
my %short_cache;
my @short_cache_order;
my $SHORT_CACHE_MAX = 256;

get '/shorten' => sub {
    my $c = shift;
    my $url = $c->param('url') // '';
    $url =~ s/^\s+|\s+$//g;

    return $c->render(text => 'Missing url',  status => 400) if $url eq '';
    return $c->render(text => 'Bad url',      status => 400) if $url !~ m{^https?://}i;
    return $c->render(text => 'Too long',     status => 413) if length($url) > 2048;
    return $c->render(text => 'Bad url',      status => 400) if $url =~ /[\x00-\x1F\x7F]/;

    if (exists $short_cache{$url}) {
        return $c->render(text => $short_cache{$url}, status => 200);
    }

    my $api = Mojo::URL->new('https://tinyurl.com/api-create.php');
    $api->query(url => $url);
    $c->render_later;

    $short_ua->get_p($api)->then(sub {
        my ($tx) = @_;
        my $res = $tx->result;
        if (!$res->is_success) { $c->render(text => 'Shorten failed', status => 502); return; }
        my $short = $res->body // '';
        $short =~ s/^\s+|\s+$//g;
        if ($short !~ m{^https?://}i) { $c->render(text => 'Shorten failed', status => 502); return; }
        $short_cache{$url} = $short;
        push @short_cache_order, $url;
        if (@short_cache_order > $SHORT_CACHE_MAX) {
            my $old = shift @short_cache_order;
            delete $short_cache{$old} if defined $old;
        }
        $c->render(text => $short, status => 200);
    })->catch(sub { $c->render(text => 'Shorten failed', status => 502); });
};

sub trace_print {
    return unless $trace_fh;
    print $trace_fh @_;
}

sub trace_dump {
    my ($tx_id, $dir, $bytes_ref) = @_;
    return unless $trace_fh && $bytes_ref;
    my $hex = join(' ', map { sprintf('%02X', $_) } @$bytes_ref);
    my $stamp = scalar(localtime());
    print $trace_fh "$stamp [koic=$Code_version tx=$tx_id] [$dir] $hex\n";
}

sub bbs_text_to_bytes {
    my ($text) = @_;
    return '' unless defined $text;

    # Normalize common “smart punctuation” to ASCII so the BBS doesn't choke.
    $text =~ s/\x{00A0}/ /g;               # NBSP
    $text =~ s/\x{2018}|\x{2019}/'/g;      # single quotes
    $text =~ s/\x{201C}|\x{201D}/"/g;     # double quotes
    $text =~ s/\x{2013}|\x{2014}/-/g;      # en/em dash
    $text =~ s/\x{2026}/.../g;             # ellipsis

    # Encode to single-byte bytes. Unknown chars become '?'.
    return encode('cp437', $text, FB_DEFAULT);
}

sub bbs_queue_write {
    my ($s, $data) = @_;
    return unless $s && defined $data;

    # Ensure we only ever buffer bytes for syswrite().
    if (utf8::is_utf8($data)) {
        my $copy = $data;
        if (utf8::downgrade($copy, 1)) {
            $data = $copy;
        } else {
            $data = bbs_text_to_bytes($data);
        }
    }
    $s->{outbuf} .= $data;

    if ($trace_fh && defined $s->{tx_id}) {
        my @out = unpack('C*', $data);
        trace_dump($s->{tx_id}, 'TX', \@out);
    }

    # Try to flush immediately; if the socket would block, arm write-watching
    # so the reactor will call us again when the socket is writable.
    if (length($s->{outbuf}) && $s->{sock}) {
        eval { bbs_flush_write($s); 1 } or do {
            my $err = $@ || 'unknown';
            $err =~ s/\s+$//;
            my $tx_id = $s->{tx_id};
            print $fh "[ERROR] Immediate write flush failed: $err\n";
            bbs_disconnect($tx_id, "BBS write failed ($err)") if defined $tx_id;
        };
        # If buffer still has data after flush attempt, arm writability watch.
        if ($s->{sock} && length($s->{outbuf})) {
            Mojo::IOLoop->singleton->reactor->watch($s->{sock}, 1, 1);
        }
    }
}

sub bbs_flush_write {
    my ($s) = @_;
    return unless $s && $s->{sock};
    return unless defined $s->{outbuf} && length $s->{outbuf};

    while (length $s->{outbuf}) {
        my $written = syswrite($s->{sock}, $s->{outbuf});
        if (defined $written) {
            last if $written == 0;
            substr($s->{outbuf}, 0, $written, '');
            next;
        }

        # Nonblocking socket: try again when writable.
        return if $!{EAGAIN} || $!{EWOULDBLOCK};

        # Hard error.
        die "bbs_flush_write syswrite failed: $!";
    }

    # Buffer fully drained — stop watching for writability.
    if ($s->{sock} && !length($s->{outbuf})) {
        Mojo::IOLoop->singleton->reactor->watch($s->{sock}, 1, 0);
    }
}

sub bbs_disconnect {
    my ($tx_id, $reason) = @_;
    my $s = $sessions{$tx_id};
    return unless $s;
    my $c = $s->{c};
    my $msg = $reason || 'BBS disconnected';
    eval {
        $c->send({binary => "\r\n\r\n[KOIC: $msg]\r\n"});
        $c->finish;
        1;
    };
    cleanup_session($tx_id);
}

# Stable build: do NOT write protocol_trace.log (it explodes in size and is not multi-user friendly).
# Normal logs go to koic-d.log via STDOUT/STDERR. Protocol tracing is opt-in via KOIC_TRACE_PROTOCOL=1.
$fh = *STDOUT{IO};
$fh->autoflush(1);

if ($ENV{KOIC_TRACE_PROTOCOL}) {
    my $trace_path = $ENV{KOIC_TRACE_PATH} || "koic-d-trace.log";
    if (open($trace_fh, '>>', $trace_path)) {
        $trace_fh->autoflush(1);
        print $fh "[INFO] Protocol tracing enabled: $trace_path\n";
    } else {
        $trace_fh = undef;
        print $fh "[WARN] KOIC_TRACE_PROTOCOL set but could not open trace file: $!\n";
    }
}

get '/' => sub { shift->render(template => 'index', code_version => $Code_version) };

websocket '/bbs' => sub {
    my $c = shift;
    my $tx_id = refaddr($c->tx);
    $c->inactivity_timeout($cfg{inactivity});

    my $sock = IO::Socket::INET->new(PeerAddr => $cfg{bbs_host}, PeerPort => $cfg{bbs_port}, Proto => 'tcp', Blocking => 0);
    if (!$sock) { $c->send("Connect Error: $!"); return; }
    $sock->autoflush(1);
    $sessions{$tx_id} = { 
        tx_id => $tx_id,
        sock => $sock, c => $c, 
        state => 'TEXT',
        handshake_sent => 0,
        input_mode => 'NORMAL',
        input_buffer => '',
        sync_counter => 0,
        pending_action => '',
        buffer => '',
        username => '',  # Empty until set via __LOGIN__ or user input at Name prompt
        password => '',
        password_prompt_time => 0,
        enemy_list => [],
        direct_editor => 0,
        in_post => 0,
        in_xmsg => 0,
        post_buffer => '',
        xmsg_buffer => '',
        blocked_post => 0,
        blocked_xmsg => 0,
        name_autofilled => 0,  # Track if we've already auto-filled the name during login
        awaiting_name => 0,  # Track if we're waiting for name input (G_NAME prompt)
        moreflag => 0,  # Toggle state for MORE_M prompts (like reference client)
        just_finished_post => 0,  # Set when POST_E fires, cleared when POST_S fires
        in_compose => -1,  # -1 = not composing, 0 = normal mode (double Return), 1 = upload mode (Ctrl+D)
        awaiting_post_finalization => 0, # legacy; no longer used for client-mode posting
        post_menu_active => 0,
        post_abort_confirm => 0,
        post_draft => '',
        awaiting_five => 0,      # G_FIVE (0xA4) local 5-line entry mode
        five_which => 0,
        five_lines => [],
        five_linebuf => '',
        pending_arg => undef,
        recipient_default => '',
        pre_name_cooldown_until => 0,
        pre_name_mode => 0,
        pre_name_buffer => '',
        pre_name_submitted => 0,
        pre_name_reason => '',
        outbuf => '',
        keepalive_id => undef,
        ansi => 1,
    };

    # Periodic keepalive: send IAC NOP every 15s to prevent BBS idle timeout.
    my $keepalive_tx = $tx_id;
    $sessions{$tx_id}->{keepalive_id} = Mojo::IOLoop->recurring(15 => sub {
        my $s = $sessions{$keepalive_tx};
        return unless $s && $s->{sock};
        bbs_queue_write($s, pack('C2', IAC, NOP));
    });

    # Browser-side keepalive: send __SERVER_PING__ every 45s so the browser
    # WebSocket stays alive even when the tab is backgrounded and the browser
    # throttles the JS setInterval that would otherwise send __PING__.
    $sessions{$tx_id}->{browser_ping_id} = Mojo::IOLoop->recurring(45 => sub {
        my $s = $sessions{$keepalive_tx};
        return unless $s && $s->{c};
        eval { $s->{c}->send({binary => '__SERVER_PING__'}); 1 };
    });

    Mojo::IOLoop->singleton->reactor->io($sock => sub {
        my ($reactor, $writable) = @_;
        my $s = $sessions{$tx_id};

        # Always flush any pending outbound data first.
        eval { bbs_flush_write($s); 1 } or do {
            my $err = $@ || 'unknown';
            $err =~ s/\s+$//;
            print $fh "[ERROR] Write flush failed: $err\n";
            bbs_disconnect($tx_id, "BBS write failed ($err)");
            return;
        };

        # When invoked for writability, we're done after flushing.
        # (Avoid sysread() here; on nonblocking sockets it can mislead debugging.)
        return if $writable;

        my $recv_data = '';
        my $bytes = sysread($sock, $recv_data, 8192);

        # Writable-only callback, no readable data.
        if (!defined $bytes) {
            return if $!{EAGAIN} || $!{EWOULDBLOCK};
            print $fh "[ERROR] sysread failed: $!\n";
            bbs_disconnect($tx_id, "BBS read failed ($!)");
            return;
        }

        # Socket closed.
        if ($bytes == 0) {
            print $fh "[INFO] BBS socket closed\n";
            bbs_disconnect($tx_id, "BBS socket closed");
            return;
        }

        my @raw = unpack('C*', $recv_data);
        my $to_browser = '';
        trace_dump($tx_id, 'RX', \@raw) if $trace_fh;
        $s = $sessions{$tx_id};
        
        # Log incoming bytes
        trace_print("[tx=$tx_id] [RX] " . join(" ", map { sprintf("%02X", $_) } @raw) . "\n");
        foreach my $b (@raw) {
            if ($s->{state} eq 'TEXT') {
                if ($b == IAC) { $s->{state} = 'IAC_SEEN'; } 
                else { 
                    # Buffer post/xmsg data instead of sending to browser
                    if ($s->{in_post}) {
                        $s->{post_buffer} .= chr($b);
                    } elsif ($s->{in_xmsg}) {
                        $s->{xmsg_buffer} .= chr($b);
                    } else {
                        $to_browser .= chr($b);
                    }
                }
            }
            elsif ($s->{state} eq 'IAC_SEEN') {
                if ($b == IAC) { $to_browser .= chr(255); $s->{state} = 'TEXT'; }
                elsif ($b == DO || $b == DONT || $b == WILL || $b == WONT) { 
                    $s->{state} = 'NEG_OPT';
                    if (!$s->{handshake_sent}) {
                        bbs_queue_write($s, pack('C*', IAC, ISCA_CLIENT2));
                        bbs_queue_write($s, pack('C*', IAC, SB, NEW_ENVIRON, 0, 1, 85, 83, 69, 82, 0, 116, 101, 108, 110, 101, 116, IAC, SE));
                        bbs_queue_write($s, pack('C*', IAC, SB, NAWS, 0, 80, 0, 24, IAC, SE));
                        $s->{handshake_sent} = 1;
                    }
                }
                elsif ($b == SB) { $s->{state} = 'SB_EAT'; }
                elsif ($b == MORE_PROMPT) {
                    # DOC protocol: 0xAB (MORE_M) is a toggle, not a one-shot signal (like reference client)
                    # Toggle moreflag to track entering/exiting prompt state
                    $s->{moreflag} ^= 1;  # XOR toggle: 0->1 or 1->0
                    
                    if ($s->{moreflag}) {
                        # Entering prompt state (0->1): this is where we auto-send
                        # Only auto-advance if NOT the final prompt (marked by just_finished_post)
                        if (!$s->{just_finished_post}) {
                            print $fh "[ACTION] MORE_PROMPT - Entering, auto-advancing\n";
                            $c->send({binary => "__MORE_PROMPT__"});
                            $s->{suppress_next_leading_ws} = 1;  # Suppress leading whitespace in next message
                        } else {
                            print $fh "[ACTION] MORE_PROMPT - Final prompt, blocking auto-send (user must press space)\n";
                            # Make this a one-shot block: otherwise a prior post-read can break paging elsewhere (e.g. Long Who list)
                            $s->{just_finished_post} = 0;
                        }
                    } else {
                        # Exiting prompt state (1->0) - no action needed
                        print $fh "[ACTION] MORE_PROMPT - Exiting prompt state\n";
                    }
                    $s->{state} = 'TEXT';
                }
                elsif ($b == ISCA_START) {
                    bbs_queue_write($s, pack('C*', IAC, ISCA_START3));
                    $s->{state} = 'TEXT';
                }
                elsif ($b == ISCA_G_NAME) {
                    $s->{state} = 'GET_ARG'; $s->{pending_action} = 'G_NAME';
                }
                elsif ($b == ISCA_G_STR) {
                    $s->{state} = 'GET_ARG'; $s->{pending_action} = 'G_STR';
                }
                elsif ($b == ISCA_G_FIVE) {
                    $s->{state} = 'GET_ARG'; $s->{pending_action} = 'G_FIVE';
                }
                elsif ($b == ISCA_CLIENT) {
                    # BBS keepalive ping — echo IAC CLIENT back immediately.
                    # Without this the BBS times out the session after 20 minutes.
                    bbs_queue_write($s, pack('C*', IAC, ISCA_CLIENT));
                    $s->{state} = 'TEXT';
                    print $fh "[ACTION] CLIENT keepalive ping -- echoed back\n";
                }
                elsif ($b == ISCA_CONFIG) {
                    $s->{state} = 'GET_ARG'; $s->{pending_action} = 'CONFIG';
                }
                elsif ($b == POST_S) {
                    $s->{in_post} = 1;
                    $s->{post_buffer} = '';
                    # Discard any text that arrived before POST_S in this TCP read
                    # (echoed keypress + "Read cmd ->" prompt — navigational noise).
                    $to_browser = '';
                    $s->{blocked_post} = 0;
                    $s->{just_finished_post} = 0;  # Clear final-prompt flag for new post
                    $s->{moreflag} = 0;  # Reset moreflag toggle for new post
                    print $fh "[ACTION] POST_S - New post starting, flags cleared\n";
                    $s->{state} = 'TEXT';
                    print $fh "[ACTION] POST_S - Post transfer starting\n";
                }
                elsif ($b == POST_E) {
                    $s->{in_post} = 0;
                    $s->{state} = 'TEXT';
                    my $sender = extract_sender($s->{post_buffer});
                    if (is_enemy($sender, $s->{enemy_list})) {
                        print $fh "[BLOCKED] Post from enemy '$sender'\n";
                        $s->{blocked_post} = 1;
                        # Don't send the post to the browser, but do show a clear notice.
                        my $notice = "\r\n\x1b[1;31m[KOIC BLOCKED Post from $sender]\x1b[0m\r\n";
                        $to_browser .= $notice;
                        # Also send to Ctrl-X viewer.
                        my $b64 = encode_base64($s->{post_buffer} // '', '');
                        $c->send({binary => "__BLOCKED_CAPTURE__:post:incoming:$sender:$b64"});
                    } else {
                        $to_browser .= $s->{post_buffer};
                    }
                    $s->{post_buffer} = '';
                    $s->{just_finished_post} = 1;  # Mark that post just ended; next MORE_PROMPT will be final
                    print $fh "[ACTION] POST_E - Post transfer ending, final prompt flag set\n";
                }
                elsif ($b == XMSG_S) {
                    $s->{in_xmsg} = 1;
                    $s->{xmsg_buffer} = '';
                    $s->{blocked_xmsg} = 0;
                    $s->{state} = 'TEXT';
                    print $fh "[ACTION] XMSG_S - Xpress message transfer starting\n";
                }
                elsif ($b == XMSG_E) {
                    $s->{in_xmsg} = 0;
                    $s->{state} = 'TEXT';
                    my $sender = extract_sender($s->{xmsg_buffer});
                    if (is_enemy($sender, $s->{enemy_list})) {
                        print $fh "[BLOCKED] Xpress from enemy '$sender'\n";
                        $s->{blocked_xmsg} = 1;
                        # Don't send the xmsg to the browser, but do show a clear notice.
                        my $notice = "\r\n\x1b[1;31m[KOIC BLOCKED Xpress from $sender]\x1b[0m\r\n";
                        $to_browser .= $notice;
                        # Also send to Ctrl-X viewer.
                        my $b64 = encode_base64($s->{xmsg_buffer} // '', '');
                        $c->send({binary => "__BLOCKED_CAPTURE__:xpress:incoming:$sender:$b64"});
                    } else {
                        # Inclusive capture: keep unblocked Xpress in the same modal queue.
                        my $b64 = encode_base64($s->{xmsg_buffer} // '', '');
                        $c->send({binary => "__CAPTURE__:xpress:incoming:$sender:$b64"});
                        # Wrap in light cyan so Xpress messages stand out from regular posts.
                        $to_browser .= "\x1b[1;36m" . $s->{xmsg_buffer} . "\x1b[0m";
                    }
                    $s->{xmsg_buffer} = '';
                    print $fh "[ACTION] XMSG_E - Xpress message transfer ending\n";
                }
                elsif ($b == 0xA5) {  # G_POST: Get post (arg: 0 = normal, 1 = upload)
                    $s->{state} = 'GET_ARG'; $s->{pending_action} = 'G_POST';
                    print $fh "[ACTION] G_POST detected, waiting for argument byte\n";
                }
                elsif ($b >= 0xA0 && $b <= 0xB1) {
                    # Generic client-mode opcode with arg + 3 sync bytes. Consume and ignore.
                    $s->{state} = 'GET_ARG'; $s->{pending_action} = 'IGNORE_GENERIC';
                }
                else { $s->{state} = 'TEXT'; }
            }
            elsif ($s->{state} eq 'NEG_OPT') {
                bbs_queue_write($s, pack('C*', IAC, WILL, $b));
                $s->{state} = 'TEXT';
            }
            elsif ($s->{state} eq 'SB_EAT') { if ($b == IAC) { $s->{state} = 'SB_IAC'; } }
            elsif ($s->{state} eq 'SB_IAC') { if ($b == SE) { $s->{state} = 'TEXT'; } else { $s->{state} = 'SB_EAT'; } }
            elsif ($s->{state} eq 'GET_ARG') {
                # All client-mode opcodes we care about follow the pattern:
                #   IAC <CMD> <ARG> <SYNC1> <SYNC2> <SYNC3>
                $s->{pending_arg} = $b;
                if ($s->{pending_action} eq 'G_POST') {
                    $s->{in_compose} = $b;  # 0=normal, 1=upload
                    print $fh "[ACTION] G_POST argument: $b (mode=" . ($b ? "upload" : "normal") . ")\n";
                }
                $s->{state} = 'SYNC_EAT';
                $s->{sync_counter} = 0;
            }
            elsif ($s->{state} eq 'SYNC_EAT') {
                $s->{sync_counter}++;
                if ($s->{sync_counter} >= 3) {
                    $s->{state} = 'TEXT';
                    my $arg = $s->{pending_arg};
                    print $fh "[ACTION] $s->{pending_action} arg=" . (defined($arg) ? $arg : 'undef') . "\n";

                    if ($s->{pending_action} eq 'G_NAME') {
                        my $name_type = $arg // 0;

                        # Only auto-fill username on initial login (ONCE per session).
                        # Classic client uses type=1 for login name.
                        if ($name_type == 1 && $s->{username} && !$s->{name_autofilled}) {
                            my $user_bytes = bbs_text_to_bytes($s->{username});
                            my $pkt = pack('C*', IAC, ISCA_BLOCK) . $user_bytes . "\n";
                            trace_print("[tx=$tx_id] [TX NAME] " . join(" ", map { sprintf("%02X", $_) } unpack('C*', $pkt)) . " -> " . $s->{username} . "\n");
                            bbs_queue_write($s, $pkt);
                            $s->{name_autofilled} = 1;
                        } else {
                            # If another name input or G_FIVE is still in progress, wait for it
                            # to finish before activating — otherwise the two states fight.
                            if ($s->{awaiting_five} || $s->{awaiting_name}) {
                                # If awaiting_name was pre-armed by __JUMP__/__SKIP_TO__ for this
                                # exact type, the BBS G_NAME is just confirming what we already set up.
                                # Don't defer -- just absorb it silently and keep going.
                                if ($s->{awaiting_name}
                                    && !$s->{awaiting_five}
                                    && ($s->{awaiting_name_type} // 0) == $name_type
                                    && length($s->{input_buffer}) == 0) {
                                    print $fh "[ACTION] G_NAME type=$name_type absorbed -- pre-armed by __JUMP__\n";
                                    # Nothing to do: awaiting_name already set, JS already notified.
                                    last;
                                }
                                my $reason = $s->{awaiting_five} ? 'awaiting_five' : 'awaiting_name';
                                print $fh "[ACTION] G_NAME type=$name_type deferred -- $reason still active\n";
                                my $my_tx   = $tx_id;
                                my $my_type = $name_type;
                                Mojo::IOLoop->timer(1.5 => sub {
                                    my $ss = $sessions{$my_tx};
                                    return unless $ss;
                                    $ss->{pre_name_mode}      = 0;
    								$ss->{pre_name_buffer}    = '';
    								$ss->{pre_name_submitted} = 0;
                                    $ss->{awaiting_name_type} = $my_type;
                                    $ss->{awaiting_name} = 1;
                                    $ss->{input_buffer} = '';
                                    eval { $ss->{c}->send({binary => "__AWAITING_NAME__:$my_type"}); 1 };
                                    print $fh "[ACTION] Deferred G_NAME type=$my_type now active\n";
                                });
                                return;
                            }

                            # If the browser already saw the "Recipient:" prompt, it may have
                            # started typing before this G_NAME arrived. Consume that prebuffer.
                            my $prefill = '';
                            my $presub  = 0;
                            if ($s->{pre_name_mode}) {
                                # Respect cooldown from previous prebuffer submit.
                                if ($s->{pre_name_cooldown_until} && time() < $s->{pre_name_cooldown_until}) {
                                    print $fh "[RECIP PROMPT] Prebuffer auto-submit suppressed (cooldown)\n";
                                    $s->{pre_name_mode} = 0;
                                    $s->{pre_name_buffer} = '';
                                    $s->{pre_name_submitted} = 0;
                                } else {
                                    $prefill = $s->{pre_name_buffer} // '';
                                    $presub  = $s->{pre_name_submitted} ? 1 : 0;
                                    $s->{pre_name_mode} = 0;
                                    $s->{pre_name_buffer} = '';
                                    $s->{pre_name_submitted} = 0;
                                    $s->{pre_name_reason} = '';
                                    print $fh "[RECIP PROMPT] Consumed prebuffer len=" . length($prefill) . " presub=$presub\n";
                                }
                            }

                            $s->{awaiting_name_type} = $name_type;
                            $s->{input_buffer} = $prefill;

                            # If the user already pressed Enter before G_NAME arrived, submit now.
                            if ($presub) {
                                submit_name_input($s, $c, $name_type, $s->{input_buffer});
                                $s->{awaiting_name} = 0;
                                $s->{awaiting_name_type} = 0;
                                $s->{input_buffer} = '';
                                # Brief cooldown: prevent the next G_NAME from also auto-submitting
                                # via a stale prebuffer (e.g. back-to-back profile+xpress).
                                $s->{pre_name_cooldown_until} = time() + 0.5;                            
                            } else {
                                $s->{awaiting_name} = 1;
                                eval { $c->send({binary => "__AWAITING_NAME__:$name_type"}); 1 };
                                print $fh "[ACTION] Awaiting user input for G_NAME type=$name_type\n";
                            }
                        }
                    }
                    elsif ($s->{pending_action} eq 'G_STR') {
                        print $fh "[TX] Ready for G_STR input\n";
                        $s->{input_mode} = 'PASSWORD';
                        $s->{input_buffer} = '';
                        $s->{password_prompt_time} = time();
                        eval { $c->send({binary => "__AWAITING_STR__"}); 1 };
                    }
                    elsif ($s->{pending_action} eq 'CONFIG') {
                        my $ansi = ($s->{ansi} // 1) ? 1 : 0;
                        bbs_queue_write($s, pack('C*', IAC, ISCA_BLOCK) . "80 24 $ansi\n");
                        $c->send({binary => "__CLIENT_CONFIG__"});
                    }
                    elsif ($s->{pending_action} eq 'G_POST') {
                        $s->{compose_buffer} = '';
                        print $fh "[ACTION] Entering text composition mode (mode=" . ($s->{in_compose} ? "upload" : "normal") . ")\n";
                        if ($s->{direct_editor}) {
                            # Send empty draft to open scratchpad directly.
                            use MIME::Base64 qw(encode_base64);
                            my $b64 = encode_base64('', '');
                            $c->send({binary => "__EDIT_DRAFT__:$b64"});
                            print $fh "[ACTION] G_POST direct_editor: sent __EDIT_DRAFT__ (empty)\n";
                        } else {
                            $c->send({binary => "__COMPOSE_START__"});
                        }
                    }
                    elsif ($s->{pending_action} eq 'G_FIVE') {
                        my $which = $arg // 0;
                        $s->{awaiting_five} = 1;
                        $s->{five_which} = $which;
                        $s->{five_lines} = [];
                        $s->{five_linebuf} = '';
                        $c->send({binary => "__FIVE_START__:$which"});
                        print $fh "[ACTION] Entering G_FIVE local entry mode which=$which\n";
                    }

                    $s->{pending_action} = '';
                    $s->{pending_arg} = undef;
                }
            }
        }
        
        # Suppress leading whitespace in first message after MORE_PROMPT
        if ($s->{suppress_next_leading_ws} && length $to_browser) {
            $to_browser =~ s/^\s+//;
            $s->{suppress_next_leading_ws} = 0;
            print $fh "[DEBUG] Suppressed leading WS from message after MORE_PROMPT\n";
        }

        # BBS server keepalive: strip __SERVER_PING__ from display and echo back.
        # The BBS sends this as plain text every ~60s; clients must suppress and acknowledge it.
        while ($to_browser =~ s/__SERVER_PING__\r?\n?//) {
            bbs_queue_write($s, "__SERVER_PING__\n");
            print $fh "[PING] BBS __SERVER_PING__ received and echoed\n";
        }

        eval {
            $c->send({binary => $to_browser}) if length $to_browser && $sessions{$tx_id};
            1;
        } or do {
            print $fh "[WARN] send to browser failed (transaction destroyed), cleaning up\n";
            cleanup_session($tx_id);
        };
    })->watch($sock, 1, 0);

    $c->on(message => sub { 
        my ($c, $msg) = @_;
        my $s = $sessions{$tx_id};
		print $fh "[MSG] " . length($msg) . " bytes" .
            ($s->{input_mode} eq 'PASSWORD' ? ": (password suppressed)" : ": " . substr($msg, 0, 40)) . "\n";
        # Browser-side WebSocket keepalive ping (sent every ~2.5 min by koic.js).
        # Absorb silently so the reverse proxy sees activity and doesn't cut the connection.
        if ($msg eq '__PING__') {
            print $fh "[PING] WebSocket keepalive from browser\n";
            return;
        }

        # Default recipient hint from frontend (e.g. "Recipient (Feoh):")
    	if ($msg =~ /^__RECIP_DEFAULT__:(.*)$/s) {
            my $d = $1 // '';
            $d =~ s/[\r\n]//g;
            $s->{recipient_default} = $d;
            print $fh "[RECIP DEFAULT] $d\n";
            return;
        }

        # Frontend hint: recipient prompt is on-screen (lets us pre-buffer fast typing
        # before the server's G_NAME arrives).
        if ($msg eq '__RECIP_PROMPT__') {
		    # If G_NAME is already active, the pre-buffer is irrelevant — ignore.
    		if ($s->{awaiting_name}) {
        	print $fh "[RECIP PROMPT] Ignored -- awaiting_name already active\n";
        	return;
    		}
    		$s->{pre_name_mode} = 1;
    		$s->{pre_name_buffer} = '';
    		$s->{pre_name_submitted} = 0;
    		$s->{pre_name_reason} = 'RECIP';
    		print $fh "[RECIP PROMPT] Pre-buffer enabled\n";
    		return;
		}

		# __JUMP__ / __SKIP_TO__: JS sends these instead of the raw key + __EXPECT_GNAME__.
		# Atomically arms awaiting_name AND forwards the command key in one step.
		# Eliminates the race window where fast-typed chars arrive before G_NAME is processed.
		if ($msg eq '__JUMP__' || $msg eq '__SKIP_TO__') {
			my $cmd  = ($msg eq '__JUMP__') ? 'j' : 'S';
			my $type = 3;	# G_NAME type for forum jump / skip-to
			print $fh "[JUMP] Atomic arm: cmd=$cmd type=$type\n";
			$s->{pre_name_mode}		= 0;
			$s->{pre_name_buffer}	= '';
			$s->{pre_name_submitted}	= 0;
			$s->{pre_name_reason}	= '';
			$s->{awaiting_name}		= 1;
			$s->{awaiting_name_type}	= $type;
			$s->{input_buffer}		= '';
			bbs_queue_write($s, $cmd);
			eval { $c->send({binary => "__AWAITING_NAME__:3"}); 1 };
			return;
		}

		# Legacy __EXPECT_GNAME__ — kept for x/X (Xpress) and other G_NAME triggers.
		# Frontend hint: a command was issued that should soon trigger G_NAME.
		if ($msg eq '__EXPECT_GNAME__') {
            my $stale = $s->{pre_name_buffer} // '';
            print $fh "[EXPECT GNAME] Pre-buffer enabled (stale='" . $stale . "')\n";
            $s->{pre_name_mode} = 1;
            $s->{pre_name_buffer} = '';
            $s->{pre_name_submitted} = 0;
            $s->{pre_name_reason} = 'EXPECT';

            # Safety timeout: if G_NAME never arrives, release buffered input to the BBS.
            my $my_tx = $tx_id;
            Mojo::IOLoop->timer(2.0 => sub {
                my $ss = $sessions{$my_tx};
                return unless $ss && $ss->{pre_name_mode};
                my $raw = $ss->{pre_name_buffer} // '';
                my $send = $raw;
                $send .= "\r" if $ss->{pre_name_submitted};
                if ($send ne '') {
                    print $fh "[EXPECT GNAME] Timeout: releasing buffered input len=" . length($send) . "\n";
                    bbs_queue_write($ss, $send);
                }
                $ss->{pre_name_mode} = 0;
                $ss->{pre_name_buffer} = '';
                $ss->{pre_name_submitted} = 0;
                $ss->{pre_name_reason} = '';
            });
            return;
        }

        # G_FIVE (0xA4): local five-line entry mode (used for Xpress and profile info)
        if ($s->{awaiting_five}) {
            for my $ch (split(//, $msg)) {
                my $ord = ord($ch);

                if ($ch eq "\r" || $ch eq "\n") {
                    my $line = $s->{five_linebuf} // '';
                    $line =~ s/[\r\n]+//g;

                    push @{$s->{five_lines}}, $line;
                    $s->{five_linebuf} = '';

                    my $is_first = (@{$s->{five_lines}} == 1);
                    my $finish = 0;

                    # Special commands supported by classic client for X messages
                    if ($is_first && $line eq 'PING') {
                        $s->{five_lines} = [''];
                        $finish = 1;
                    } elsif ($line eq 'ABORT') {
                        $finish = 1;
                    } elsif ($line eq '') {
                        # Blank line terminates (and is included in what we send)
                        $finish = 1;
                    }

                    if ($finish) {
                        my $pkt = pack('C2', IAC, ISCA_BLOCK);
                        for my $l (@{$s->{five_lines}}) {
                            $pkt .= bbs_text_to_bytes($l) . "\n";
                        }
                        trace_print("[tx=$tx_id] [TX FIVE] which=$s->{five_which} lines=" . scalar(@{$s->{five_lines}}) . " bytes=" . length($pkt) . "\n");
                        bbs_queue_write($s, $pkt);

                        $s->{awaiting_five} = 0;
                        $s->{five_which} = 0;
                        $s->{five_lines} = [];
                        $s->{five_linebuf} = '';
                        $c->send({binary => "__FIVE_END__"});
                        last;
                    } else {
                        $c->send({binary => "__FIVE_PROMPT__"});
                    }
                    next;
                }

                if ($ord == 0x08 || $ord == 0x7F) {
                    if (length($s->{five_linebuf}) > 0) {
                        $s->{five_linebuf} = substr($s->{five_linebuf}, 0, -1);
                    }
                    next;
                }

                # Classic client limits each line to 78 chars.
                next if length($s->{five_linebuf}) >= 78;
                $s->{five_linebuf} .= $ch;
            }
            return;
        }

        # Pre-buffer recipient typing if the prompt is visible but G_NAME hasn't arrived yet.
        # This prevents early keystrokes from being sent raw to the BBS (and later "missing"
        # from the local G_NAME buffer), which caused false enemy-blocking via default fallback.
        if ($s->{pre_name_mode} && !$s->{awaiting_name} && $s->{input_mode} ne 'PASSWORD' && !$s->{post_menu_active} && !$s->{awaiting_five} && ($s->{in_compose} // -1) < 0) {
            # Important: for Jump ('j'), we want to prebuffer the *following* forum name/number,
            # but we must not delay the triggering command itself.
            if (($s->{pre_name_reason} // '') eq 'EXPECT'
                && ($s->{pre_name_buffer} // '') eq ''
                && !$s->{pre_name_submitted}
                && (defined($msg) && length($msg) == 1)
                && ($msg eq 'j' || $msg eq 'J')) {
                print $fh "[EXPECT GNAME] Passing through jump command immediately\n";
                bbs_queue_write($s, $msg);
                return;
            }

            my $forward = '';
            for my $ch (split(//, $msg)) {
                my $ord = ord($ch);

                if ($ch eq "\r" || $ch eq "\n") {
                    $s->{pre_name_submitted} = 1;
                    next;
                }

                if ($ord == 0x08 || $ord == 0x7F) {
                    if (length($s->{pre_name_buffer}) > 0) {
                        $s->{pre_name_buffer} = substr($s->{pre_name_buffer}, 0, -1);
                    }
                    next;
                }

                # If user hits Ctrl-C (or other control keys), stop prebuffering and let it through.
                if ($ord < 0x20) {
                    $s->{pre_name_mode} = 0;
                    $s->{pre_name_buffer} = '';
                    $s->{pre_name_submitted} = 0;
                    $s->{pre_name_reason} = '';
                    $forward .= $ch;
                    next;
                }

                $s->{pre_name_buffer} .= $ch;
            }

            if (length $forward) {
                print $fh "[RECIP PROMPT] forwarding control bytes: " . join(" ", map { sprintf("%02X", $_) } unpack('C*', $forward)) . "\n";
                bbs_queue_write($s, $forward);
            }
            return;
        }

        # Updated draft content from the scratchpad editor (local, client-side)
        if ($msg =~ /^__DRAFT__:(.*)$/s) {
            $s->{post_draft} = $1;
            $s->{post_menu_active} = 1;
            $c->send({binary => "__POST_MENU__"});
            my $b64 = encode_base64($s->{post_draft} // '', '');
            $c->send({binary => "__DRAFT_RENDER__:$b64"});
            print $fh "[DRAFT] Draft updated from editor (" . length($s->{post_draft}) . " bytes)\n";
            return;
        }

        # Post-action menu (client-side). Do NOT forward these keystrokes to the BBS.
        if ($s->{post_menu_active}) {
            my $choice = $msg;
            $choice =~ s/[\r\n\s]//g;
            $choice = lc(substr($choice, 0, 1) // '');

            # Abort confirmation sub-mode
            if ($s->{post_abort_confirm}) {
                if ($choice eq 'y') {
                    print $fh "[POST] Abort confirmed (BLOCK + CTRL_D+'a')\n";
                    my $pkt = pack('C2', IAC, ISCA_BLOCK) . pack('C', CTRL_D) . 'a';
                    trace_print("[tx=$tx_id] [TX POST ABORT] " . join(" ", map { sprintf("%02X", $_) } unpack('C*', $pkt)) . "\n");
                    bbs_queue_write($s, $pkt);
                    $s->{post_abort_confirm} = 0;
                    $s->{post_menu_active} = 0;
                    $s->{post_draft} = '';
                    $s->{in_compose} = -1;
                    $s->{compose_buffer} = '';
                    $c->send({binary => "__POST_MENU_END__"});
                    return;
                }

                # Default: treat anything other than 'y' as cancel
                $s->{post_abort_confirm} = 0;
                $c->send({binary => "\r\n[Abort cancelled]\r\n"});
                $c->send({binary => "__POST_MENU_PROMPT__"});
                return;
            }

            if ($choice eq 'p') {
                my $pretty = wrap_post_text($s->{post_draft} // '', 78);
                $pretty =~ s/\n/\r\n/g;
                $c->send({binary => "\r\n" . $pretty . "\r\n"});
                $c->send({binary => "__POST_MENU_PROMPT__"});
                return;
            }

            if ($choice eq 'e') {
                my $b64 = encode_base64($s->{post_draft} // '', '');
                $c->send({binary => "__EDIT_DRAFT__:$b64"});
                return;
            }

            if ($choice eq 'c') {
                $s->{post_menu_active} = 0;
                $s->{in_compose} = 0;
                $s->{compose_buffer} = $s->{post_draft} // '';
                $s->{compose_buffer} =~ s/\r?\n/\r/g;
                $c->send({binary => "__POST_MENU_END__"});
                $c->send({binary => "__COMPOSE_START__"});
                $c->send({binary => "\r\n[Continue editing - hit Enter twice to finish]\r\n"});
                return;
            }

            if ($choice eq 'a') {
                # Match traditional UX: ask before aborting.
                $s->{post_abort_confirm} = 1;
                $c->send({binary => "\r\nAbort: are you sure? (Y/N) -> "});
                return;
            }

            if ($choice eq 's') {
                my $body = wrap_post_text($s->{post_draft} // '', 78);
                # Use CR as newline inside ISCA_BLOCK payload (matches classic client behavior more closely)
                $body =~ s/\r\n?|\n/\r/g;
                $body .= "\r" if $body ne '' && $body !~ /\r\z/;
                print $fh "[POST] Save selected (BLOCK + body + CTRL_D+'s') body_len=" . length($body) . "\n";
                my $body_bytes = bbs_text_to_bytes($body);
                my $pkt = pack('C2', IAC, ISCA_BLOCK) . $body_bytes . pack('C', CTRL_D) . 's';
                trace_print("[tx=$tx_id] [TX POST SAVE] " . join(" ", map { sprintf("%02X", $_) } unpack('C*', $pkt)) . "\n");
                bbs_queue_write($s, $pkt);
                $s->{post_menu_active} = 0;
                $s->{post_draft} = '';
                $s->{in_compose} = -1;
                $s->{compose_buffer} = '';
                $c->send({binary => "__POST_MENU_END__"});
                return;
            }

            # Unknown choice; re-prompt
            $c->send({binary => "__POST_MENU_PROMPT__"});
            return;
        }
        
        my @bytes = unpack('C*', $msg);
        trace_print("[tx=$tx_id] [TX FROM TERM] " . join(" ", map { sprintf("%02X", $_) } @bytes) . " -> " . $msg . "\n");
        # Check for special commands (e.g., __LOGIN__:username, __ENEMIES__:list)
        if ($msg =~ /^__LOGIN__:(.+)$/) {
            $s->{username} = $1;
            print $fh "[LOGIN] Username set to: " . $s->{username} . "\n";
            return;
        }
        if ($msg =~ /^__ENEMIES__:(.*)$/) {
            my $enemy_str = $1;
            # Parse comma or newline separated enemy list
            $s->{enemy_list} = [grep { $_ } split(/[\n,\r]+/, $enemy_str)];
            print $fh "[ENEMIES] List updated: " . join(", ", @{$s->{enemy_list}}) . "\n";
            return;
        }
        if ($msg =~ /^__PREF_DIRECT_EDITOR__:(\d)$/) {
            $s->{direct_editor} = $1 ? 1 : 0;
            print $fh "[PREF] direct_editor=" . $s->{direct_editor} . "\n";
            return;
        }
        
        # Ignore input for 800ms after password prompt to prevent buffered username replay
        if ($s->{input_mode} eq 'PASSWORD' && time() - $s->{password_prompt_time} < 0.8) {
            # Only ignore if the input matches the username (buffered keystroke)
            my $clean_msg = $msg;
            $clean_msg =~ s/[\r\n]//g;
            if ($clean_msg eq $s->{username}) {
                print $fh "[IGNORED] Buffered username '" . $s->{username} . "' blocked during password prompt\n";
                return;
            }
        }
        
        if ($s->{input_mode} eq 'PASSWORD') {
            if ($msg =~ /\r/) {
                $s->{input_buffer} .= $msg;
                $s->{input_buffer} =~ s/\r//g;
                my $pw_bytes = bbs_text_to_bytes($s->{input_buffer});
                my $pkt = pack('C*', IAC, ISCA_BLOCK) . $pw_bytes . "\n";
                trace_print("[tx=$tx_id] [TX PASSWORD] " . join(" ", map { sprintf("%02X", $_) } unpack('C*', $pkt)) . "\n");
                bbs_queue_write($s, $pkt);
                $s->{input_mode} = 'NORMAL';
                $s->{input_buffer} = '';
            } else {
                $s->{input_buffer} .= $msg;
            }
        } elsif ($s->{awaiting_name}) {
            # G_NAME: gather locally (do not forward keystrokes to BBS), then send as a BLOCK + "\n".
            my $submitted = 0;
            for my $ch (split(//, $msg)) {
                my $ord = ord($ch);

                if ($ch eq "\r" || $ch eq "\n") {
                    next if $submitted;

                    my $name_type = ($s->{awaiting_name_type} // 0);
                    submit_name_input($s, $c, $name_type, $s->{input_buffer});

                    $s->{awaiting_name} = 0;
                    $s->{awaiting_name_type} = 0;
                    $s->{input_buffer} = '';
                    $submitted = 1;
                    next;
                }

                if ($ord == 0x08 || $ord == 0x7F) {
                    if (length($s->{input_buffer}) > 0) {
                        $s->{input_buffer} = substr($s->{input_buffer}, 0, -1);
                    }
                    next;
                }

                $s->{input_buffer} .= $ch;
            }

            return;
        } elsif ($s->{in_compose} >= 0) {  # >= 0 means we're in composition mode
            # G_POST (0xA5) means BBS is ready to receive post via character-by-character input
            # For normal mode (0): detect double Return and auto-send `.s` save command (suppress 2nd CR)
            # For upload (1): use Ctrl+D
            
            if ($s->{in_compose} == 2) {
                # Message was sent, waiting for BBS response - buffer all input but don't forward
                print $fh "[WAITING] in_compose=2, buffering input (suppressing: " . unpack('H*', $msg) . ")\n";
                # Silently drop the input - we're in a protocol wait state
            } else {
                # Client-side composition (both normal and upload modes): buffer locally.
                # End entry on DOUBLE-RETURN (traditional behavior). Ctrl+D is still accepted if it arrives.

                my $finish = 0;
                for my $ch (split(//, $msg)) {
                    my $ord = ord($ch);

                    if ($ord == CTRL_D) {
                        $finish = 1;
                        next;
                    }

                    if ($ord == 0x08 || $ord == 0x7F) {
                        if (length($s->{compose_buffer}) > 0) {
                            $s->{compose_buffer} = substr($s->{compose_buffer}, 0, -1);
                        }
                        next;
                    }

                    # Treat LF as CR for safety
                    if ($ch eq "\n") {
                        $ch = "\r";
                    }

                    $s->{compose_buffer} .= $ch;
                    if ($s->{compose_buffer} =~ /\r\r\z/) {
                        $finish = 1;
                    }
                }

                if ($finish) {
                    $s->{compose_buffer} =~ s/\r\r\z//;

                    my $draft = $s->{compose_buffer} // '';
                    $draft =~ s/\r\n?/\n/g;
                    $s->{post_draft} = $draft;

                    $s->{post_menu_active} = 1;
                    $s->{in_compose} = 2; # waiting/menu state
                    $c->send({binary => "__COMPOSE_END__"});
                    $c->send({binary => "__POST_MENU__"});
                    $c->send({binary => "__POST_MENU_PROMPT__"});
                    print $fh "[POST] Composition ended; entering local post menu (draft_len=" . length($s->{post_draft}) . ")\n";
                    return;
                }

                return;
            }
		} else {
    		if ($msg =~ /\r/) {
		        print $fh "[CR RECEIVED] Forwarding to BBS\n";
		    }
		    # If awaiting_name is already active, this char raced the __AWAITING_NAME__
		    # signal to JS — route it into the name buffer instead of forwarding raw.
		    if ($s->{awaiting_name}) {
		        print $fh "[FWD->NAME] Racing char rerouted to name buffer\n";
		        for my $ch (split(//, $msg)) {
		            my $ord = ord($ch);
		            if ($ch eq "\r" || $ch eq "\n") {
		                my $name_type = ($s->{awaiting_name_type} // 0);
		                submit_name_input($s, $c, $name_type, $s->{input_buffer});
		                $s->{awaiting_name} = 0;
		                $s->{awaiting_name_type} = 0;
		                $s->{input_buffer} = '';
		                last;
		            }
		            if ($ord == 0x08 || $ord == 0x7F) {
		                $s->{input_buffer} = substr($s->{input_buffer}, 0, -1) if length($s->{input_buffer});
		                next;
		            }
		            $s->{input_buffer} .= $ch;
		        }
		        return;
		    }
		    print $fh "[FWD] " . join(" ", map { sprintf("%02X", $_) } unpack('C*', $msg)) . "\n";
		    bbs_queue_write($s, $msg);
		}
	});
		    
	$c->on(finish => sub { cleanup_session($tx_id); });
};
		
sub cleanup_session {
    my ($tx_id) = @_;
    my $s = delete $sessions{$tx_id};
    if ($s) {
        Mojo::IOLoop->remove($s->{keepalive_id})    if $s->{keepalive_id};
        Mojo::IOLoop->remove($s->{browser_ping_id}) if $s->{browser_ping_id};
        Mojo::IOLoop->singleton->reactor->remove($s->{sock});
        $s->{sock}->close;
    }
}

sub extract_sender {
    my ($text) = @_;
    # Strip ANSI escape sequences before matching
    $text =~ s/\e\[[0-9;]*m//g;
    if ($text =~ /from\s+(\w+)/i) {
        return $1;
    }
    return '';
}

sub is_enemy {
    my ($sender, $enemy_list_ref) = @_;
    return 0 unless $sender && $enemy_list_ref;
    my %enemies = map { lc($_) => 1 } @$enemy_list_ref;
    return exists $enemies{lc($sender)};
}

sub wrap_post_text {
    my ($text, $width) = @_;
    $width ||= 78;
    $text //= '';
    $text =~ s/\r\n/\n/g;
    $text =~ s/\r/\n/g;

    my @paras = split(/\n{2,}/, $text, -1);
    my @out;

    for my $p (@paras) {
        if (!defined($p) || $p =~ /^\s*\z/) {
            push @out, '';
            next;
        }

        # Preserve indented/quoted blocks without reflow.
        if ($p =~ /^(?:[ \t]|>)/m) {
            my $keep = $p;
            $keep =~ s/[ \t]+$//mg;
            push @out, $keep;
            next;
        }

        my $norm = $p;
        $norm =~ s/\n/ /g;
        $norm =~ s/\s+/ /g;
        $norm =~ s/^\s+|\s+$//g;

        my @words = split(/ /, $norm);
        my @lines;
        my $line = '';
        for my $w (@words) {
            next if $w eq '';
            if ($line eq '') {
                $line = $w;
                next;
            }
            if (length($line) + 1 + length($w) <= $width) {
                $line .= " $w";
            } else {
                push @lines, $line;
                $line = $w;
            }
        }
        push @lines, $line if $line ne '';
        push @out, join("\n", @lines);
    }

    return join("\n\n", @out);
}

sub submit_name_input {
    my ($s, $c, $name_type, $raw_name) = @_;
    my $name = $raw_name // '';
    $name =~ s/[\r\n]+//g;
    my $effective = $name;

    # Always clear pre-name buffering mode — G_NAME has taken over.
    $s->{pre_name_mode}      = 0;
    $s->{pre_name_buffer}    = '';
    $s->{pre_name_submitted} = 0;

    # Enemy-list block for outbound Xpress: recipient entry is G_NAME type 2.
    if (($name_type // 0) == 2 && $effective ne '' && is_enemy($effective, $s->{enemy_list})) {
        my $pkt = pack('C*', IAC, ISCA_BLOCK) . "\n";  # blank recipient cancels/backs out
        print $fh "[BLOCKED] Outbound Xpress recipient '$effective' blocked (sending blank recipient)\n";
        trace_print("[TX NAME INPUT BLOCKED] " . join(" ", map { sprintf("%02X", $_) } unpack('C*', $pkt)) . "\n");
        bbs_queue_write($s, $pkt);
        $c->send({binary => "\r\n\x1b[1;31m[KOIC BLOCKED outgoing Xpress to $effective]\x1b[0m\r\n"});
        return 0;
    }

    my $name_bytes = bbs_text_to_bytes(ucfirst($name));
    my $pkt = pack('C*', IAC, ISCA_BLOCK) . $name_bytes . "\n";
    trace_print("[TX NAME INPUT] " . join(" ", map { sprintf("%02X", $_) } unpack('C*', $pkt)) . " -> " . $name . "\n");
    bbs_queue_write($s, $pkt);
    return 1;
}

app->static->paths->[0] = app->home->rel_file('lib-d');
app->start('daemon', '-l', 'http://127.0.0.1:17258');

__DATA__
@@ index.html.ep
<!DOCTYPE html>
<html>
<head>
    <title>KOIC v<%= $code_version %></title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.1.0/css/xterm.css" />
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500&family=JetBrains+Mono:wght@400;500&family=Source+Code+Pro:wght@400;600&family=IBM+Plex+Mono:wght@400;500&family=Inconsolata:wght@400;600&family=Roboto+Mono:wght@400;500&family=Ubuntu+Mono:wght@400;700&family=Red+Hat+Mono:wght@400;500&family=PT+Mono&display=swap" />
    <link rel="stylesheet" href="/koic.css?v=<%= $code_version %>" />
</head>
<body>
    <div id="start-overlay" onclick="startSession()">
        <div id="start-prompt">
            <h1>KOIC v<%= $code_version %></h1>
            <p>Ready for Initialization</p>
            <p style="color:#666">Bugs? Send Mail to DrMemory</p>
            <div style="margin-top:15px; font-size:14px; color:#00CC00;">
                Mobile Version:<br/>
                http://bbs-mobile.dawoods.com/
            </div>
            <p style="margin-top:20px; font-weight:bold;">[ CLICK TO START ]</p>
        </div>
    </div>
    
    <div id="main-layout">
        <div id="terminal-container">
            <div id="editor-panel"
                 role="dialog"
                 aria-modal="true"
                 aria-labelledby="editor-panel-title">
                <span id="editor-panel-title"
                      style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;padding:0;margin:-1px;">
                    Post editor
                </span>
                <textarea id="scratchpad"
                	placeholder="Drafting area..."
                    aria-label="Post editor"
                    aria-multiline="true">
                </textarea>
                <div class="editor-btn-bar">
                    <button onclick="cancelEditor()" class="scale-btn">CANCEL</button>
                    <button id="editor-done-btn" onclick="sendToBBS()" style="color:#000; background:#00CC00;" class="scale-btn">DONE</button>
                </div>
            </div>
            <div id="editor-drag-handle" title="Drag to resize" aria-hidden="true"></div>
            <div id="terminal-gutter"><div id="terminal"></div></div>
            <div id="settings-modal" class="full-overlay">
                <div class="modal-content">
                    <h3>Client Settings</h3>
                    <label>User Handle (for Autofill):</label>
                    <input type="text" id="setting-handle" placeholder="DrMemory">
                    <div style="margin: 15px 0;">
                        <input type="checkbox" id="setting-ansi" style="width: auto; margin-right: 10px;">
                        <label for="setting-ansi" style="color: #00CC00; font-size: 12px;">Auto-enable ANSI on Login</label>
                    </div>
                    <label>Font (monospace):</label>
                    <select id="setting-font">
                        <option value="Consolas, 'Courier New', monospace">Consolas</option>
                        <option value="'Courier New', Courier, monospace">Courier New</option>
                        <option value="'Fira Code', Menlo, Monaco, monospace">Fira Code (Google Font)</option>
                        <option value="'IBM Plex Mono', Menlo, Monaco, monospace">IBM Plex Mono (Google Font)</option>
                        <option value="Inconsolata, Menlo, Monaco, monospace">Inconsolata (Google Font)</option>
                        <option value="'JetBrains Mono', Menlo, Monaco, monospace">JetBrains Mono (Google Font)</option>
                        <option value="Menlo, Monaco, monospace">Menlo</option>
                        <option value="Menlo, Monaco, 'Courier New', monospace">Menlo / Monaco (macOS default-ish)</option>
                        <option value="Monaco, Menlo, monospace">Monaco</option>
                        <option value="'MonoLisa', Menlo, Monaco, monospace">MonoLisa (local install)</option>
                        <option value="'PT Mono', Menlo, Monaco, monospace">PT Mono (Google Font)</option>
                        <option value="'Red Hat Mono', Menlo, Monaco, monospace">Red Hat Mono (Google Font)</option>
                        <option value="'Roboto Mono', Menlo, Monaco, monospace">Roboto Mono (Google Font)</option>
                        <option value="'SF Mono', Menlo, Monaco, monospace">SF Mono</option>
                        <option value="'Source Code Pro', Menlo, Monaco, monospace">Source Code Pro (Google Font)</option>
                        <option value="'Ubuntu Mono', Menlo, Monaco, monospace">Ubuntu Mono (Google Font)</option>
                    </select>
                    <label>Enemy List (one name per line):</label>
                    <textarea id="setting-enemies" style="background:#000; border:1px solid #333; color:#F00; padding:10px; width:100%; height:80px; margin:10px 0; font-family:monospace; resize:none;"></textarea>
                    <div style="margin: 15px 0;">
                        <input type="checkbox" id="setting-shorten" style="width: auto; margin-right: 10px;">
                        <label for="setting-shorten" style="color: #00CC00; font-size: 12px;">Shorten long URLs via TinyURL</label>
                    </div>
                    <label>Shorten URLs longer than (chars):</label>
                    <input type="number" id="setting-shorten-threshold" min="40" max="200" value="80" style="width:6em; background:#000; border:1px solid #333; color:#00CC00; padding:10px; margin:10px 0; font-family:monospace;">
                    <div style="margin: 15px 0;">
                        <input type="checkbox" id="setting-direct-editor" style="width: auto; margin-right: 10px;">
                        <label for="setting-direct-editor" style="color: #00CC00; font-size: 12px;">Open scratchpad editor directly when posting (e)</label>
                    </div>
                    <div class="button-group" style="margin-top:20px;">
                        <button class="dash-btn wide" onclick="saveSettings()">SAVE & CLOSE</button>
                        <button class="dash-btn wide" style="color:#666" onclick="toggleOverlay('settings-modal')">CANCEL</button>
                    </div>
                </div>
            </div>

            <div id="blocked-modal" class="full-overlay">
                <div class="modal-content">
                    <h3>Blocked Message Viewer (Ctrl-X)</h3>
                    <div style="color:#00CC00; font-size:12px;">Shows the most recently blocked post/Xpress (not forwarded to the BBS).</div>
                    <textarea id="blocked-viewer" readonly placeholder="No blocked messages captured yet."></textarea>
                    <div class="button-group" style="margin-top:10px;">
                        <button class="dash-btn wide" onclick="blockedPrev()">PREV</button>
                        <button class="dash-btn wide" onclick="blockedNext()">NEXT</button>
                    </div>
                    <div class="button-group" style="margin-top:10px;">
                        <button class="dash-btn wide" onclick="copyBlocked()">COPY</button>
                        <button class="dash-btn wide" style="color:#666" onclick="toggleOverlay('blocked-modal')">CLOSE</button>
                    </div>
                </div>
            </div>
        </div>
        
        <div id="desktop-sidebar">
            <h3>Navigation</h3>
            <div class="button-group">
                <button class="dash-btn" onclick="sendCommand(' ', false)">NEXT [Spc]</button>
                <button class="dash-btn" onclick="sendCommand('j', true)">JUMP [j]</button>
                <button class="dash-btn" onclick="sendCommand('s', false)">SKIP [s]</button>
                <button class="dash-btn" onclick="sendCommand('S', true)">SKIP TO [S]</button>
                <button class="dash-btn" onclick="sendCommand('k', false)">FORUMS [k]</button>
            </div>
            
            <h3>Reading</h3>
            <div class="button-group">
                <button class="dash-btn wide" onclick="sendCommand(' ', false)">NEXT POST [Spc]</button>
                <button class="dash-btn" onclick="sendCommand('b', false)">BACK [b]</button>
                <button class="dash-btn" onclick="sendCommand('e', true)">POST [e]</button>
                <button class="dash-btn" onclick="sendCommand('s', false)">STOP [s]</button>
                <button class="dash-btn" onclick="sendCommand('a', false)">AGAIN [a]</button>
                <button class="dash-btn" onclick="sendCommand('i', false)">INFO [i]</button>
            </div>

            <h3>Social</h3>
            <div class="button-group">
                <button class="dash-btn" onclick="sendCommand('w', false)">WHO [w]</button>
                <button class="dash-btn" onclick="sendCommand('W', false)">WHO LONG [W]</button>
                <button class="dash-btn" onclick="sendCommand('x', true)">XPRESS [x]</button>
                <button class="dash-btn" onclick="sendCommand('p', false)">PROFILE [p]</button>
            </div>

            <h3>System</h3>
            <div class="button-group">
                <button class="dash-btn" onclick="toggleOverlay('settings-modal')">Configuration</button>
                <button class="dash-btn" onclick="sendCommand('y', true)">YELL [y]</button>
                <button class="dash-btn" onclick="sendCommand('Q', false)">GUIDE [Q]</button>
                <button class="dash-btn" onclick="sendCommand('h', false)">HELP [h]</button>
                <button class="dash-btn" onclick="sendCommand('?', false)">CMDS [?]</button>
                <button class="dash-btn" style="color:#F00" onclick="sendCommand('l', false)">LOGOUT [l]</button>
            </div>
        </div>
    </div>
    
    <div id="status-bar">
        <span id="status-left">
            <span id="status-msg" class="status-warn">READY</span>
        </span>
        <span>
            <button onclick="reconnect()" style="background:#111; color:#00CC00; border:1px solid #333; padding:4px 12px; font-family:monospace; font-size:11px; cursor:pointer; margin-right:15px;">RECONNECT</button>
            KOIC DESKTOP v<%= $code_version %>
        </span>
    </div>

    <!-- ARIA live region: mirrors terminal output as plain text for screen readers (VoiceOver, NVDA, etc.) -->
    <div id="aria-live-region"
         role="log"
         aria-live="polite"
         aria-atomic="false"
         aria-label="Terminal output"
         style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;padding:0;margin:-1px;">
    </div>
	    <!-- ARIA live region: mirrors scratchpad keystrokes for screen readers -->
    <div id="aria-live-region-editor"
         role="status"
         aria-live="polite"
         aria-atomic="true"
         aria-label="Editor content"
         style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;padding:0;margin:-1px;">
    </div>
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.1.0/lib/xterm.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.7.0/lib/xterm-addon-fit.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.8.0/lib/xterm-addon-web-links.js"></script>
    <script>window.KOIC_VERSION = '<%= $code_version %>';</script>
    <script src="/koic.js?v=<%= $code_version %>"></script>
</body>
</html>