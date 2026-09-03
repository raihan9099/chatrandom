// server.js - Complete Video Calling App Backend
const express = require('express');
const http = require('http');
const https = require('https');
const socketio = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketio(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/videos', express.static(path.join(__dirname, 'videos')));

// Create uploads and videos directories
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('videos')) fs.mkdirSync('videos');

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/videochatapp', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB Connected'))
  .catch(err => console.log('MongoDB Error:', err));

// ==================== MODELS ====================

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  avatar: { type: String, default: '/uploads/default-avatar.png' },
  gender: { type: String, enum: ['male', 'female', 'other'] },
  age: Number,
  coins: { type: Number, default: 100 },
  isOnline: { type: Boolean, default: false },
  isInCall: { type: Boolean, default: false },
  lastActive: { type: Date, default: Date.now },
  socketId: String,
  preferences: {
    gender: String,
    ageMin: Number,
    ageMax: Number
  },
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});

const VideoSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  title: String,
  description: String,
  videoUrl: String,
  thumbnailUrl: String,
  duration: Number,
  views: { type: Number, default: 0 },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});

const CallHistorySchema = new mongoose.Schema({
  callerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  startTime: Date,
  endTime: Date,
  duration: Number,
  type: { type: String, enum: ['random', 'friend', 'video'] }
});

const GiftSchema = new mongoose.Schema({
  name: String,
  price: Number,
  icon: String,
  animation: String
});

const TransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['recharge', 'gift_sent', 'gift_received', 'purchase'] },
  amount: Number,
  description: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Video = mongoose.model('Video', VideoSchema);
const CallHistory = mongoose.model('CallHistory', CallHistorySchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

// ==================== VIDEO UPLOAD CONFIG ====================

const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'videos/');
  },
  filename: (req, file, cb) => {
    cb(null, uuidv4() + path.extname(file.originalname));
  }
});

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, uuidv4() + path.extname(file.originalname));
  }
});

const videoUpload = multer({ 
  storage: videoStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Not a video file!'), false);
    }
  }
});

const imageUpload = multer({ 
  storage: imageStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Not an image file!'), false);
    }
  }
});

// ==================== AUTH MIDDLEWARE ====================

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ==================== AUTH ROUTES ====================

app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, gender, age } = req.body;
    
    // Check if user exists
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const user = new User({
      username,
      email,
      password: hashedPassword,
      gender,
      age,
      coins: 100 // Free coins for new users
    });
    
    await user.save();
    
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '30d' }
    );
    
    res.json({ token, user: { id: user._id, username, email, avatar: user.avatar, coins: user.coins } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '30d' }
    );
    
    res.json({ 
      token, 
      user: { 
        id: user._id, 
        username: user.username, 
        email: user.email, 
        avatar: user.avatar,
        coins: user.coins,
        gender: user.gender
      } 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== USER ROUTES ====================

app.get('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select('-password')
      .populate('friends', 'username avatar isOnline');
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/user/profile', authMiddleware, imageUpload.single('avatar'), async (req, res) => {
  try {
    const updates = req.body;
    if (req.file) {
      updates.avatar = `/uploads/${req.file.filename}`;
    }
    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true })
      .select('-password');
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/users/online', authMiddleware, async (req, res) => {
  try {
    const users = await User.find({ 
      isOnline: true, 
      isInCall: false,
      _id: { $ne: req.user._id }
    })
    .select('username avatar age gender')
    .limit(50);
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== VIDEO ROUTES ====================

app.post('/api/videos/upload', authMiddleware, videoUpload.single('video'), async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }
    
    const video = new Video({
      userId: req.user._id,
      title,
      description,
      videoUrl: `/videos/${req.file.filename}`,
      thumbnailUrl: `/uploads/${req.file.filename}.jpg` // Generate thumbnail later
    });
    
    await video.save();
    res.json(video);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/videos', authMiddleware, async (req, res) => {
  try {
    const videos = await Video.find()
      .populate('userId', 'username avatar')
      .sort({ createdAt: -1 })
      .limit(20);
    res.json(videos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/videos/:id', authMiddleware, async (req, res) => {
  try {
    const video = await Video.findById(req.params.id)
      .populate('userId', 'username avatar');
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    video.views++;
    await video.save();
    res.json(video);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== COINS & GIFTS ====================

const giftTypes = {
  rose: { price: 10, icon: '🌹', name: 'Rose' },
  heart: { price: 20, icon: '❤️', name: 'Heart' },
  crown: { price: 100, icon: '👑', name: 'Crown' },
  diamond: { price: 500, icon: '💎', name: 'Diamond' },
  car: { price: 1000, icon: '🚗', name: 'Luxury Car' },
  yacht: { price: 5000, icon: '🛥️', name: 'Yacht' }
};

app.post('/api/coins/recharge', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;
    const user = await User.findById(req.user._id);
    user.coins += amount;
    await user.save();
    
    const transaction = new Transaction({
      userId: user._id,
      type: 'recharge',
      amount,
      description: `Recharged ${amount} coins`
    });
    await transaction.save();
    
    res.json({ coins: user.coins });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/gifts/send', authMiddleware, async (req, res) => {
  try {
    const { toUserId, giftType } = req.body;
    const gift = giftTypes[giftType];
    
    if (!gift) {
      return res.status(400).json({ error: 'Invalid gift type' });
    }
    
    const sender = await User.findById(req.user._id);
    const receiver = await User.findById(toUserId);
    
    if (!receiver) {
      return res.status(404).json({ error: 'Receiver not found' });
    }
    
    if (sender.coins < gift.price) {
      return res.status(400).json({ error: 'Insufficient coins' });
    }
    
    sender.coins -= gift.price;
    receiver.coins += Math.floor(gift.price * 0.5); // Receiver gets 50%
    
    await sender.save();
    await receiver.save();
    
    // Emit gift event to receiver
    if (receiver.socketId) {
      io.to(receiver.socketId).emit('gift-received', {
        from: sender.username,
        gift: giftType,
        icon: gift.icon
      });
    }
    
    res.json({ success: true, remainingCoins: sender.coins });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== MATCHING SYSTEM ====================

const waitingQueue = [];
const activeCalls = new Map();

class MatchingSystem {
  static addToQueue(userId, socketId, preferences) {
    const existingIndex = waitingQueue.findIndex(q => q.userId === userId);
    if (existingIndex !== -1) {
      waitingQueue.splice(existingIndex, 1);
    }
    
    waitingQueue.push({
      userId,
      socketId,
      preferences,
      timestamp: Date.now()
    });
    
    return MatchingSystem.findMatch(userId);
  }
  
  static removeFromQueue(userId) {
    const index = waitingQueue.findIndex(q => q.userId === userId);
    if (index !== -1) {
      waitingQueue.splice(index, 1);
    }
  }
  
  static findMatch(userId) {
    const user = waitingQueue.find(q => q.userId === userId);
    if (!user) return null;
    
    const match = waitingQueue.find(q => {
      if (q.userId === userId) return false;
      
      // Check gender preference
      if (user.preferences?.gender && user.preferences.gender !== 'any') {
        // Need to check actual gender of potential match
        return true; // Simplified for now
      }
      
      return true;
    });
    
    if (match) {
      MatchingSystem.removeFromQueue(userId);
      MatchingSystem.removeFromQueue(match.userId);
      
      const callId = uuidv4();
      activeCalls.set(callId, {
        participants: [userId, match.userId],
        startTime: Date.now(),
        type: 'random'
      });
      
      return {
        callId,
        user1: { userId, socketId: user.socketId },
        user2: { userId: match.userId, socketId: match.socketId }
      };
    }
    
    return null;
  }
}

// ==================== SOCKET.IO HANDLING ====================

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  // User authentication for socket
  socket.on('user-connect', async (data) => {
    try {
      const { userId } = data;
      await User.findByIdAndUpdate(userId, {
        isOnline: true,
        socketId: socket.id
      });
      
      socket.userId = userId;
      io.emit('user-online', { userId });
    } catch (error) {
      console.error('Socket auth error:', error);
    }
  });
  
  // Start random call
  socket.on('start-random-call', async (data) => {
    try {
      const { userId, preferences } = data;
      const match = MatchingSystem.addToQueue(userId, socket.id, preferences);
      
      if (match) {
        // Notify both users
        io.to(match.user1.socketId).emit('match-found', {
          callId: match.callId,
          peerSocketId: match.user2.socketId
        });
        
        io.to(match.user2.socketId).emit('match-found', {
          callId: match.callId,
          peerSocketId: match.user1.socketId
        });
      } else {
        socket.emit('waiting-for-match');
      }
    } catch (error) {
      console.error('Random call error:', error);
    }
  });
  
  // Cancel random call search
  socket.on('cancel-random-call', (data) => {
    const { userId } = data;
    MatchingSystem.removeFromQueue(userId);
    socket.emit('search-cancelled');
  });
  
  // WebRTC signaling
  socket.on('offer', (data) => {
    socket.to(data.to).emit('offer', {
      offer: data.offer,
      from: socket.id
    });
  });
  
  socket.on('answer', (data) => {
    socket.to(data.to).emit('answer', {
      answer: data.answer,
      from: socket.id
    });
  });
  
  socket.on('ice-candidate', (data) => {
    socket.to(data.to).emit('ice-candidate', {
      candidate: data.candidate,
      from: socket.id
    });
  });
  
  // Chat messages
  socket.on('send-message', (data) => {
    const { to, message, roomId } = data;
    if (roomId) {
      socket.to(roomId).emit('new-message', {
        from: socket.userId,
        message,
        timestamp: Date.now()
      });
    } else {
      socket.to(to).emit('new-message', {
        from: socket.userId,
        message,
        timestamp: Date.now()
      });
    }
  });
  
  // Typing indicator
  socket.on('typing', (data) => {
    socket.to(data.to).emit('user-typing', {
      userId: socket.userId
    });
  });
  
  // End call
  socket.on('end-call', async (data) => {
    const { callId, userId } = data;
    const call = activeCalls.get(callId);
    
    if (call) {
      const otherUserId = call.participants.find(id => id !== userId);
      const otherUser = await User.findById(otherUserId);
      
      if (otherUser?.socketId) {
        io.to(otherUser.socketId).emit('call-ended', { callId });
      }
      
      // Save call history
      const callHistory = new CallHistory({
        callerId: call.participants[0],
        receiverId: call.participants[1],
        startTime: new Date(call.startTime),
        endTime: new Date(),
        duration: Math.floor((Date.now() - call.startTime) / 1000),
        type: call.type
      });
      await callHistory.save();
      
      activeCalls.delete(callId);
    }
  });
  
  // Disconnect
  socket.on('disconnect', async () => {
    console.log('Client disconnected:', socket.id);
    
    if (socket.userId) {
      await User.findByIdAndUpdate(socket.userId, {
        isOnline: false,
        isInCall: false,
        socketId: null,
        lastActive: new Date()
      });
      
      MatchingSystem.removeFromQueue(socket.userId);
      io.emit('user-offline', { userId: socket.userId });
    }
  });
});

// ==================== ADMIN ROUTES ====================

app.get('/api/admin/stats', authMiddleware, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const onlineUsers = await User.countDocuments({ isOnline: true });
    const inCalls = await User.countDocuments({ isInCall: true });
    const totalVideos = await Video.countDocuments();
    const totalCalls = await CallHistory.countDocuments();
    
    res.json({
      totalUsers,
      onlineUsers,
      inCalls,
      totalVideos,
      totalCalls,
      activeCalls: activeCalls.size,
      waitingQueue: waitingQueue.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SERVER START ====================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Video calling app is ready!`);
  console.log(`- Upload videos to /api/videos/upload`);
  console.log(`- Start random calls via socket.io`);
  console.log(`- Send gifts to other users`);
});
